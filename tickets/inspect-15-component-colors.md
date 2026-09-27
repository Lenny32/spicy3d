# INSPECT-15: Display Component Colors

## Summary

Add a reversible automatic color mode for distinguishing model components.

Status: planned. Priority: P2.

## Scope

- Define Spicy3D component identity explicitly using existing node/group semantics; document differences from an assembly component model.
- Assign stable distinguishable colors and coordinated tree indicators without changing stored materials.
- Provide an Inspect toggle and resolve shortcut conflicts before adding a binding.
- Define behavior for nested groups, ungrouped bodies, new nodes, and other active analysis overrides.

## Implementation Areas

packages/core/src/model/, packages/three/src/, packages/ui/src/, packages/builder/src/ribbon.ts.

## Acceptance Criteria

- [ ] Components retain stable colors after reorder, edits, and save/load.
- [ ] Nested ownership and ungrouped-body fallback follow the documented rules.
- [ ] Toggling off restores each original material and appearance.
- [ ] Selection/highlighting remains readable and switching analysis modes does not leak overrides.
- [ ] Apply the shared implementation and verification requirements in the [Inspect roadmap](inspect-roadmap.md).

## Dependencies and Complexity

Dependencies: 00. Numbered dependencies refer to INSPECT tickets in the [roadmap](inspect-roadmap.md). Complexity: medium.

