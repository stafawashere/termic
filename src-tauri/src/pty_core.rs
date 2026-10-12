// The PTY output pipeline, shared by the app's own PTYs and the PTY daemon
// (ptyd.rs). Where the bytes end up is the only thing that differs between
// them, so that part is a `PtySink`: the app's sink emits Tauri events, the
// daemon's sends frames to whichever client is subscribed.
//
// Reader -> shared buffer -> flusher -> sink, and a waiter that reports the
// exit only after the reader has put its last bytes on the wire. The buffer
// is paired with a Condvar so the flusher and the waiter BLOCK while there is
// nothing to do: a quiet PTY costs zero wakeups (docs/performance.md, bear
// trap 9).

use parking_lot::{Condvar, Mutex};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Where a PTY's output goes. Both calls come from the pipeline's own
/// threads, never under one of its locks.
pub(crate) trait PtySink: Send + Sync + 'static {
    fn output(&self, data: Vec<u8>);
    fn exit(&self, code: Option<i32>);
}

/// How long the flusher holds a PTY's first output waiting for the webview
/// to say it is listening. Sized for "the ack is late", not "the ack never
/// comes": the normal ack lands within milliseconds of the spawn resolving,
/// and after the grace expires output flows anyway, so a caller that never
/// acks costs a one-time delay rather than a wedged terminal.
pub(crate) const PTY_ATTACH_GRACE: Duration = Duration::from_secs(3);

/// The flusher's coalescing window. Bulk output (`cat large.txt`) batches
/// into a handful of events instead of one per 64 KiB read, for at most 8 ms
/// of added latency on an interactive echo.
pub(crate) const PTY_COALESCE: Duration = Duration::from_millis(8);

/// Block until the webview acks its listener, the process dies, or the grace
/// expires. Split out of the flusher so the three exits are unit-testable
/// without a real PTY (`wait_for_attach_*` tests).
pub(crate) fn wait_for_attach(
    buf: &(Mutex<Vec<u8>>, Condvar),
    attached: &AtomicBool,
    done: &AtomicBool,
    grace: Duration,
) {
    let mut b = buf.0.lock();
    let deadline = Instant::now() + grace;
    loop {
        if attached.load(Ordering::Acquire) || done.load(Ordering::Acquire) { return; }
        let now = Instant::now();
        if now >= deadline { return; }
        buf.1.wait_for(&mut b, deadline - now);
    }
}

/// The reader -> flusher -> waiter handshake state of one PTY.
#[derive(Clone)]
pub(crate) struct PtyPump {
    pub(crate) buf: Arc<(Mutex<Vec<u8>>, Condvar)>,
    pub(crate) done: Arc<AtomicBool>,
    /// Set once the consumer has registered its listener. The flusher holds
    /// its FIRST emit until then (see `wait_for_attach`).
    pub(crate) attached: Arc<AtomicBool>,
}

impl PtyPump {
    pub(crate) fn new() -> Self {
        PtyPump {
            buf: Arc::new((Mutex::new(Vec::new()), Condvar::new())),
            done: Arc::new(AtomicBool::new(false)),
            attached: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn push(&self, data: &[u8]) {
        self.buf.0.lock().extend_from_slice(data);
        self.buf.1.notify_all();
    }

    /// The consumer is listening, so output may go on the wire. Stored under
    /// the buffer mutex, exactly like the reader's `done` store: a store
    /// outside it can land between the flusher's check and its wait, and that
    /// wakeup is lost (the terminal then waits out the whole grace).
    pub(crate) fn mark_attached(&self) {
        let _b = self.buf.0.lock();
        self.attached.store(true, Ordering::Release);
        self.buf.1.notify_all();
    }

    /// The reader's last act at EOF: emit whatever the flusher has not picked
    /// up yet, then signal done so the waiter can report the exit after all
    /// output is on the wire.
    pub(crate) fn finish(&self, sink: &dyn PtySink) {
        let remaining = std::mem::take(&mut *self.buf.0.lock());
        if !remaining.is_empty() {
            // Same gate as the flusher, for the same reason: a process that
            // prints and exits faster than the webview can register its
            // listener (a one-shot command in a terminal tab) would otherwise
            // have its ENTIRE output emitted to nobody. `done` is still false
            // here, so this waits on the ack, not on itself.
            wait_for_attach(&self.buf, &self.attached, &self.done, PTY_ATTACH_GRACE);
            sink.output(remaining);
        }
        // Set `done` and notify UNDER the buffer mutex. The flusher and the
        // waiter both check `done` while holding it, then park; a store
        // without the lock can land exactly between a consumer's check and
        // its wait(), so the notify hits nobody and the consumer parks
        // forever (lost wakeup: the exit never fires, the slot never leaves
        // the map). Taking the mutex forces the store to happen either
        // before the consumer's check (it sees `done`, never parks) or after
        // it parked (the notify reaches it). The final-data emit above must
        // stay BEFORE this block so the exit can't overtake the last bytes.
        let _b = self.buf.0.lock();
        self.done.store(true, Ordering::Release);
        self.buf.1.notify_all();
    }

    /// Block until the reader has finished. Parks on the condvar the reader
    /// signals: the previous `sleep(1ms)` spin burned ~1000 wakeups/s, and
    /// if an orphaned grandchild kept the PTY slave open (reader never hits
    /// EOF) it spun forever, long after the pane was closed.
    pub(crate) fn wait_done(&self) {
        let mut b = self.buf.0.lock();
        while !self.done.load(Ordering::Acquire) {
            self.buf.1.wait(&mut b);
        }
    }

    /// Like `wait_done`, but gives up after `limit`. Returns whether the
    /// reader finished.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn wait_done_for(&self, limit: Duration) -> bool {
        let mut b = self.buf.0.lock();
        let deadline = Instant::now() + limit;
        while !self.done.load(Ordering::Acquire) {
            let now = Instant::now();
            if now >= deadline { break; }
            self.buf.1.wait_for(&mut b, deadline - now);
        }
        self.done.load(Ordering::Acquire)
    }

    /// Flusher thread: block until the reader signals fresh output, then
    /// sleep ONE coalescing window (so bulk output still batches into few
    /// events), drain, emit. While the PTY is quiet this thread is parked on
    /// the condvar: no timer, no wakeups. A zero `coalesce` emits each
    /// wakeup's bytes straight away, for a consumer whose producer already
    /// coalesced.
    pub(crate) fn spawn_flusher(&self, sink: Arc<dyn PtySink>, coalesce: Duration) {
        let pump = self.clone();
        thread::spawn(move || {
            // Nothing goes on the wire until someone is listening. The reader
            // keeps filling the buffer meanwhile, so this delays the first
            // paint by however long the ack takes and loses nothing.
            wait_for_attach(&pump.buf, &pump.attached, &pump.done, PTY_ATTACH_GRACE);
            loop {
                {
                    let mut b = pump.buf.0.lock();
                    while b.is_empty() && !pump.done.load(Ordering::Acquire) {
                        pump.buf.1.wait(&mut b);
                    }
                    if b.is_empty() {
                        break; // reader done and its final flush already emitted
                    }
                }
                if !coalesce.is_zero() {
                    thread::sleep(coalesce);
                }
                let data = std::mem::take(&mut *pump.buf.0.lock());
                if !data.is_empty() {
                    sink.output(data);
                }
                if pump.done.load(Ordering::Acquire) {
                    break;
                }
            }
        });
    }

    /// Drain a PTY reader into this pump until EOF, then `finish`. `on_chunk`
    /// sees every read after it is buffered; `on_eof` runs before the final
    /// flush.
    pub(crate) fn run_reader(
        &self,
        mut reader: Box<dyn Read + Send>,
        sink: &dyn PtySink,
        mut on_chunk: impl FnMut(&[u8]),
        on_eof: impl FnOnce(),
    ) {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    self.push(&buf[..n]);
                    on_chunk(&buf[..n]);
                }
            }
        }
        on_eof();
        self.finish(sink);
    }
}

/// What an attach tap receives. `Data` is raw PTY output; `Detach` is a
/// server-initiated end (task archived) the client must surface with
/// its reason. PTY exit needs no message: the slot (and with it every
/// tap sender) drops when the waiter cleans up, so receivers see a
/// disconnect.
pub(crate) enum PtyTapMsg {
    Data(Vec<u8>),
    Detach(String),
}

/// Retained output ring + live attach taps for one PTY.
/// ONE mutex over both: the reader thread appends to the ring and fans
/// out to taps as one atomic step, so an attach that registers its tap
/// while snapshotting the backlog can neither miss a chunk nor receive
/// it twice.
pub(crate) struct PtyFeed {
    pub(crate) inner: Mutex<PtyFeedInner>,
}

pub(crate) struct PtyFeedInner {
    ring: PtyRing,
    pub(crate) taps: Vec<std::sync::mpsc::SyncSender<PtyTapMsg>>,
}

impl PtyFeed {
    /// Bounded tap depth. The attach forwarder normally drains
    /// immediately; its socket write times out after 10s, so this only
    /// fills when the client stalls under a firehose PTY. Overflow
    /// force-detaches that tap (its receiver sees a disconnect) instead
    /// of buffering the agent's output stream without bound. Worst
    /// in-flight memory per tap: 256 chunks x 64 KiB reads = 16 MiB.
    const TAP_DEPTH: usize = 256;

    pub(crate) fn new() -> Self {
        Self::with_cap(PtyRing::CAP)
    }

    pub(crate) fn with_cap(cap: usize) -> Self {
        PtyFeed {
            inner: Mutex::new(PtyFeedInner { ring: PtyRing::with_cap(cap), taps: Vec::new() }),
        }
    }

    /// Reader-thread path: retain the chunk and forward it to every
    /// live tap, dropping taps whose receiver hung up or stalled past
    /// the bound. Never blocks (this is the PTY reader thread).
    pub(crate) fn push(&self, data: &[u8]) {
        let mut inner = self.inner.lock();
        inner.ring.push(data);
        inner
            .taps
            .retain(|tx| tx.try_send(PtyTapMsg::Data(data.to_vec())).is_ok());
    }

    /// Seed the ring with output this process did not read itself (a daemon
    /// PTY's snapshot on reattach), without forwarding it to any tap.
    pub(crate) fn seed(&self, data: &[u8]) {
        self.inner.lock().ring.push(data);
    }

    pub(crate) fn send_detach(&self, reason: &str) {
        let mut inner = self.inner.lock();
        inner
            .taps
            .retain(|tx| tx.try_send(PtyTapMsg::Detach(reason.to_string())).is_ok());
    }

    /// The reader thread's LAST act at PTY EOF: a blocking detach
    /// notice to every tap, so the forwarder learns "exited" in-band
    /// (channel disconnect alone is not enough: the attach input
    /// thread holds a sender clone, see `PtyAttachment.tx`). Blocking
    /// is bounded: a stalled forwarder dies on its 10s socket write
    /// timeout, dropping the receiver and erroring the send.
    pub(crate) fn send_detach_final(&self, reason: &str) {
        let taps = std::mem::take(&mut self.inner.lock().taps);
        for tx in taps {
            let _ = tx.send(PtyTapMsg::Detach(reason.to_string()));
        }
    }

    /// Register a live tap and snapshot the backlog atomically. The
    /// returned sender clone lets the session's OWN input thread post
    /// an in-band detach, so the forwarder can block on recv() with no
    /// polling and no stop flag.
    pub(crate) fn subscribe(
        &self,
    ) -> (Vec<u8>, bool, std::sync::mpsc::Receiver<PtyTapMsg>, std::sync::mpsc::SyncSender<PtyTapMsg>)
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(Self::TAP_DEPTH);
        let mut inner = self.inner.lock();
        inner.taps.push(tx.clone());
        let (backlog, truncated) = inner.ring.tail(usize::MAX);
        (backlog, truncated, rx, tx)
    }

    pub(crate) fn tail(&self, max: usize) -> (Vec<u8>, bool) {
        self.inner.lock().ring.tail(max)
    }
}

/// Byte ring holding the last `cap` bytes of a PTY's output, so `termic logs`
/// and attach-with-backlog can show what the GUI terminal shows without
/// retaining unbounded scrollback server-side. 256 KiB comfortably
/// covers a full TUI redraw plus recent turns.
pub(crate) struct PtyRing {
    buf: std::collections::VecDeque<u8>,
    cap: usize,
    dropped: bool,
}

impl PtyRing {
    pub(crate) const CAP: usize = 256 * 1024;

    /// A daemon-owned PTY keeps running while no app is attached, and what it
    /// writes in that gap is only ever seen through this ring.
    pub(crate) const DAEMON_CAP: usize = 4 * 1024 * 1024;

    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_cap(Self::CAP)
    }

    pub(crate) fn with_cap(cap: usize) -> Self {
        PtyRing { buf: std::collections::VecDeque::new(), cap, dropped: false }
    }

    pub(crate) fn push(&mut self, data: &[u8]) {
        // A single chunk larger than the cap keeps only its tail.
        let start = data.len().saturating_sub(self.cap);
        if start > 0 {
            self.dropped = true;
        }
        self.buf.extend(&data[start..]);
        if self.buf.len() > self.cap {
            self.buf.drain(..self.buf.len() - self.cap);
            self.dropped = true;
        }
    }

    /// Last `max` bytes plus whether anything older was ever dropped
    /// (by the cap or by `max`).
    pub(crate) fn tail(&self, max: usize) -> (Vec<u8>, bool) {
        let skip = self.buf.len().saturating_sub(max);
        (
            self.buf.iter().skip(skip).copied().collect(),
            self.dropped || skip > 0,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    enum Event {
        Out(Vec<u8>),
        Exit(Option<i32>),
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Event>>);

    impl PtySink for Recorder {
        fn output(&self, data: Vec<u8>) {
            self.0.lock().push(Event::Out(data));
        }
        fn exit(&self, code: Option<i32>) {
            self.0.lock().push(Event::Exit(code));
        }
    }

    /// Hands its chunks out one read at a time, pausing between them so the
    /// flusher really does run concurrently with the reader.
    struct SlowReader(std::collections::VecDeque<Vec<u8>>);

    impl Read for SlowReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(chunk) => {
                    thread::sleep(Duration::from_millis(3));
                    out[..chunk.len()].copy_from_slice(&chunk);
                    Ok(chunk.len())
                }
            }
        }
    }

    #[test]
    fn every_chunk_reaches_the_sink_before_the_exit() {
        let chunks: Vec<Vec<u8>> = (0..40).map(|i| format!("line {i}\n").into_bytes()).collect();
        let expected: Vec<u8> = chunks.concat();
        let pump = PtyPump::new();
        let recorder = Arc::new(Recorder::default());
        pump.spawn_flusher(recorder.clone(), PTY_COALESCE);
        pump.mark_attached();

        let reader_pump = pump.clone();
        let reader_sink = recorder.clone();
        let reader = Box::new(SlowReader(chunks.into_iter().collect()));
        let reader_thread = thread::spawn(move || {
            reader_pump.run_reader(reader, reader_sink.as_ref(), |_| {}, || {});
        });
        pump.wait_done();
        recorder.exit(Some(0));
        reader_thread.join().unwrap();

        let events = recorder.0.lock();
        let last = events.last().expect("events recorded");
        assert_eq!(*last, Event::Exit(Some(0)));
        let exits = events.iter().filter(|e| matches!(e, Event::Exit(_))).count();
        assert_eq!(exits, 1);
        let delivered: Vec<u8> = events
            .iter()
            .filter_map(|e| match e {
                Event::Out(d) => Some(d.clone()),
                Event::Exit(_) => None,
            })
            .flatten()
            .collect();
        assert_eq!(delivered, expected);
    }

    #[test]
    fn output_written_before_the_ack_is_held_not_lost() {
        let pump = PtyPump::new();
        let recorder = Arc::new(Recorder::default());
        pump.spawn_flusher(recorder.clone(), Duration::ZERO);
        pump.push(b"banner");
        thread::sleep(Duration::from_millis(40));
        assert!(recorder.0.lock().is_empty(), "emitted before anyone listened");
        pump.mark_attached();
        let deadline = Instant::now() + Duration::from_secs(5);
        while recorder.0.lock().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(*recorder.0.lock(), vec![Event::Out(b"banner".to_vec())]);
    }

    #[test]
    fn pty_ring_caps_and_reports_truncation() {
        let mut ring = PtyRing::new();
        ring.push(b"hello ");
        ring.push(b"world");
        let (tail, truncated) = ring.tail(usize::MAX);
        assert_eq!(tail, b"hello world");
        assert!(!truncated);
        // A capped tail flags the drop.
        let (tail, truncated) = ring.tail(5);
        assert_eq!(tail, b"world");
        assert!(truncated);
        // Overflow keeps the newest CAP bytes and flags the drop for good.
        ring.push(&vec![b'x'; PtyRing::CAP]);
        let (tail, truncated) = ring.tail(usize::MAX);
        assert_eq!(tail.len(), PtyRing::CAP);
        assert!(tail.iter().all(|b| *b == b'x'));
        assert!(truncated);
        // A single chunk larger than the cap keeps only its tail.
        let mut ring = PtyRing::new();
        let mut big = vec![b'a'; PtyRing::CAP];
        big.extend_from_slice(b"end");
        ring.push(&big);
        let (tail, truncated) = ring.tail(usize::MAX);
        assert_eq!(tail.len(), PtyRing::CAP);
        assert!(tail.ends_with(b"end"));
        assert!(truncated);
    }

    #[test]
    fn a_daemon_ring_holds_more_than_an_app_ring() {
        let mut ring = PtyRing::with_cap(PtyRing::DAEMON_CAP);
        ring.push(&vec![b'y'; PtyRing::CAP * 2]);
        let (tail, truncated) = ring.tail(usize::MAX);
        assert_eq!(tail.len(), PtyRing::CAP * 2);
        assert!(!truncated);
    }

    #[test]
    fn wait_for_attach_returns_as_soon_as_the_webview_acks() {
        // The normal path: the flusher parks, the ack lands a moment later,
        // output flows. Nothing may wait out the grace here.
        let buf: Arc<(Mutex<Vec<u8>>, Condvar)> = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let attached = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let b2 = buf.clone();
        let a2 = attached.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let _g = b2.0.lock();
            a2.store(true, Ordering::Release);
            b2.1.notify_all();
        });
        let t0 = Instant::now();
        wait_for_attach(&buf, &attached, &done, Duration::from_secs(30));
        assert!(t0.elapsed() < Duration::from_secs(5), "took {:?}", t0.elapsed());
    }

    #[test]
    fn wait_for_attach_gives_up_after_the_grace() {
        // A caller that never acks must not wedge its PTY forever: output is
        // late, not lost.
        let buf: Arc<(Mutex<Vec<u8>>, Condvar)> = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let attached = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let t0 = Instant::now();
        wait_for_attach(&buf, &attached, &done, Duration::from_millis(120));
        assert!(t0.elapsed() >= Duration::from_millis(100), "returned early: {:?}", t0.elapsed());
        assert!(t0.elapsed() < Duration::from_secs(5), "overshot: {:?}", t0.elapsed());
    }

    #[test]
    fn wait_for_attach_returns_when_the_process_dies_first() {
        // The reader's final drain waits on this too, so a child that exits
        // before the ack must not hold the exit for the whole grace.
        let buf: Arc<(Mutex<Vec<u8>>, Condvar)> = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let attached = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(true));
        let t0 = Instant::now();
        wait_for_attach(&buf, &attached, &done, Duration::from_secs(30));
        assert!(t0.elapsed() < Duration::from_secs(1), "took {:?}", t0.elapsed());
    }

    #[test]
    fn pty_feed_tap_gets_backlog_then_live_data_exactly_once() {
        let feed = PtyFeed::new();
        feed.push(b"before");
        let (backlog, truncated, rx, session_tx) = feed.subscribe();
        assert_eq!(backlog, b"before");
        assert!(!truncated);
        feed.push(b"after");
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(PtyTapMsg::Data(d)) => assert_eq!(d, b"after"),
            other => panic!("expected live data, got {:?}", other.is_ok()),
        }
        // No duplicate of the backlog on the live channel.
        assert!(rx.try_recv().is_err());
        // A detach reaches the tap in-band, from the feed AND from the
        // session's own sender clone (the input thread's path).
        feed.send_detach("archived");
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(PtyTapMsg::Detach(r)) => assert_eq!(r, "archived"),
            other => panic!("expected detach, got {:?}", other.is_ok()),
        }
        session_tx.send(PtyTapMsg::Detach("detached".into())).unwrap();
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(PtyTapMsg::Detach(r)) => assert_eq!(r, "detached"),
            other => panic!("expected detach, got {:?}", other.is_ok()),
        }
        drop(rx);
        drop(session_tx);
        feed.push(b"into the void");
        assert!(feed.inner.lock().taps.is_empty(), "dead taps must be pruned");
    }
}
