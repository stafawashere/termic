import { describe, it, expect, afterEach } from "vitest";
import {
  HOOK_OSC_SUBAGENT_PREFIX,
  parseSubagentBody,
  sessionMatches,
  setSubagentEventSink,
  deliverSubagentEvent,
  type SubagentEventOrigin,
  type SubagentHookEvent,
} from "@/lib/subagentHooks";
import {
  HOOK_OSC_BODY,
  HOOK_OSC_READY_BODY,
  HOOK_OSC_WORKING_BODY,
  HOOK_OSC_DONE_BODY,
  HOOK_OSC_SESSION_PREFIX,
  HOOK_OSC_DELEGATED_PREFIX,
  HOOK_OSC_SUBAGENT_PREFIX as REEXPORTED_PREFIX,
} from "@/lib/agentHooks";

const SESSION = "00000000-0000-0000-0000-000000000000";
const OTHER_SESSION = "11111111-1111-1111-1111-111111111111";

describe("subagent hook body", () => {
  it("is pinned against the Rust constant and routable on its prefix alone", () => {
    expect(HOOK_OSC_SUBAGENT_PREFIX).toBe("subagent ");
    expect(REEXPORTED_PREFIX).toBe(HOOK_OSC_SUBAGENT_PREFIX);

    const otherBodies = [HOOK_OSC_BODY, HOOK_OSC_READY_BODY, HOOK_OSC_WORKING_BODY, HOOK_OSC_DONE_BODY,
                         HOOK_OSC_SESSION_PREFIX, HOOK_OSC_DELEGATED_PREFIX];
    for (const other of otherBodies) {
      expect(HOOK_OSC_SUBAGENT_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(HOOK_OSC_SUBAGENT_PREFIX)).toBe(false);
    }
  });

  it("parses a start", () => {
    expect(parseSubagentBody(`start ${SESSION} a1b2c3 general-purpose`)).toEqual({
      phase: "start", sessionId: SESSION, agentId: "a1b2c3", agentType: "general-purpose",
    });
  });

  it("parses a stop", () => {
    expect(parseSubagentBody(`stop ${SESSION} a1b2c3 Explore`)).toEqual({
      phase: "stop", sessionId: SESSION, agentId: "a1b2c3", agentType: "Explore",
    });
  });

  it("strips a leading agent- from the id", () => {
    expect(parseSubagentBody(`start ${SESSION} agent-a1b2c3 Explore`)?.agentId).toBe("a1b2c3");
    expect(parseSubagentBody(`start ${SESSION} agent- Explore`)).toBeNull();
  });

  it("keeps a workflow agent's type verbatim", () => {
    expect(parseSubagentBody(`stop ${SESSION} w1 workflow-subagent`)?.agentType).toBe("workflow-subagent");
  });

  it("accepts a plugin-qualified type", () => {
    expect(parseSubagentBody(`start ${SESSION} a1 my-plugin:code.reviewer_2`)?.agentType)
      .toBe("my-plugin:code.reviewer_2");
  });

  it("rejects an agent id outside its alphabet", () => {
    for (const agentId of ["../x", "a/b", "a.b", "a:b", "a;b", "a$b", "a%b"]) {
      expect(parseSubagentBody(`start ${SESSION} ${agentId} Explore`), agentId).toBeNull();
    }
  });

  it("rejects an agent type outside its alphabet", () => {
    for (const agentType of ["a/b", "a;b", "a$b", "a%b", "a\\b", "aé"]) {
      expect(parseSubagentBody(`start ${SESSION} a1 ${agentType}`), agentType).toBeNull();
    }
  });

  it("rejects overlong fields and accepts the longest legal ones", () => {
    const longestId = "a".repeat(64);
    const longestType = "t".repeat(128);
    expect(parseSubagentBody(`start ${SESSION} ${longestId} ${longestType}`)).not.toBeNull();
    expect(parseSubagentBody(`start ${SESSION} agent-${longestId} Explore`)?.agentId).toBe(longestId);
    expect(parseSubagentBody(`start ${SESSION} ${"a".repeat(65)} Explore`)).toBeNull();
    expect(parseSubagentBody(`start ${SESSION} agent-${"a".repeat(65)} Explore`)).toBeNull();
    expect(parseSubagentBody(`start ${SESSION} a1 ${"t".repeat(129)}`)).toBeNull();
  });

  it("rejects extra tokens and stray whitespace", () => {
    expect(parseSubagentBody(`start ${SESSION} a1 Explore extra`)).toBeNull();
    expect(parseSubagentBody(`start ${SESSION} a1 Explore `)).toBeNull();
    expect(parseSubagentBody(` start ${SESSION} a1 Explore`)).toBeNull();
    expect(parseSubagentBody(`start  ${SESSION} a1 Explore`)).toBeNull();
    expect(parseSubagentBody(`start ${SESSION} a1 Explore\n`)).toBeNull();
  });

  it("rejects missing fields and unknown phases", () => {
    expect(parseSubagentBody("")).toBeNull();
    expect(parseSubagentBody("start")).toBeNull();
    expect(parseSubagentBody(`start ${SESSION}`)).toBeNull();
    expect(parseSubagentBody(`start ${SESSION} a1`)).toBeNull();
    expect(parseSubagentBody(`started ${SESSION} a1 Explore`)).toBeNull();
    expect(parseSubagentBody(`done ${SESSION} a1 Explore`)).toBeNull();
  });

  it("rejects a session id that is not a uuid", () => {
    for (const sessionId of ["not-a-uuid", "0000000g-0000-0000-0000-000000000000",
                             "00000000-0000-0000-0000-0000000000000", "brassy-polish"]) {
      expect(parseSubagentBody(`start ${sessionId} a1 Explore`), sessionId).toBeNull();
    }
  });
});

describe("subagent session filter", () => {
  const event = parseSubagentBody(`start ${SESSION} a1 Explore`)!;

  it("accepts the tab's own session", () => {
    expect(sessionMatches(event, SESSION)).toBe(true);
  });

  it("rejects a foreign session", () => {
    expect(sessionMatches(event, OTHER_SESSION)).toBe(false);
  });

  it("rejects a tab that has no session id", () => {
    expect(sessionMatches(event, null)).toBe(false);
    expect(sessionMatches(event, undefined)).toBe(false);
    expect(sessionMatches(event, "")).toBe(false);
  });
});

describe("subagent event sink", () => {
  afterEach(() => setSubagentEventSink(null));

  it("hands accepted events to whoever registered, and to nobody before that", () => {
    const event = parseSubagentBody(`stop ${SESSION} a1 Explore`)!;
    const origin = { taskId: "t1", tabId: "tab1", tabSessionId: SESSION };
    deliverSubagentEvent(origin, event);

    const received: Array<[SubagentEventOrigin, SubagentHookEvent]> = [];
    setSubagentEventSink((from, what) => received.push([from, what]));
    deliverSubagentEvent(origin, event);
    expect(received).toEqual([[origin, event]]);
  });
});
