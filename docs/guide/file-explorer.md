# File explorer

The All files tab in the right panel lists the task's files. Termic+ adds a
filter over every file in the task, buttons to create files and folders,
pinned folders and keyboard navigation.

## Find a file by name

1. Press `Shift+Cmd+E`. The right panel opens if it was hidden, switches to
   All files and puts the cursor in the filter. This works from inside a
   terminal too.
2. Type part of a file or folder name. Every file in the task is searched,
   including folders you never opened. Folders with matches open, the matching
   part of each name is highlighted, and the field shows how many files
   match.
3. Clear the field (the button at its end, or select all and delete) and the
   tree goes back to the folders you had open before.

`Cmd+P` is still the file finder. The filter is for seeing where files sit in
the tree.

## Create files and folders

1. Click the new file or new folder button in the All files header.
2. An inline row appears. Type the name and press `Enter`.
3. Press `Escape` to cancel.

Termic+ refuses a name that already exists and anything that would land
outside the task folder.

## Move around with the keyboard

Click a row, then use the arrow keys to move between rows. `Right` opens a
folder, `Left` closes it and `Enter` opens a file. The collapse all button in
the header closes every folder at once.

## Read the tree

Names are colored by git status (added, modified or deleted), and a dot marks
a row with uncommitted changes inside it. Indent guides show nesting, with the
guide for the folder you are in highlighted. Pinned folders sit in their own
section at the top, and each row has a menu at its end for the usual file
actions.
