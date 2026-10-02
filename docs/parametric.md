
Sketch timeline anchors (`SketchData.refPositions[body.id]`) count preceding features. Inserting
at k shifts anchors greater than k up; removing k shifts them down. An anchor equal to k keeps
seeing the state entering that step. A feature move is allowed only if every anchored sketch's
set of preceding features still forms a prefix of the reordered list. Such a prefix has the same
length, so its anchor stays unchanged; a move across an anchored boundary returns a `Result`
error before writing anything. Anchor updates and feature edits use normal setters within the
caller's transaction, including removal of extrude target links, so undo/redo restores both.
