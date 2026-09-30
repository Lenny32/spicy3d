# Fillet and chamfer failures

Tracked and ordinary corner operations validate edge indexes and finite positive dimensions before
entering OCCT. Degenerate edges fail with their selected index. If OCCT does not accept a selected
edge into a contour, the error reports the index and requested size. Available topology identifies
an edge with fewer than two adjoining faces or faces explicitly marked tangent (G1 or higher).
Unmarked geometric tangency is not asserted as a certain cause.

Failed fillet builds report the radius, contour count, available faulty contour statuses and faulty
corner vertex count. OCCT start-solution failure means the radius **may** be too large or incompatible
with local geometry. Twisted-surface and walking failures retain their specific native status.
At most eight faulty contours are expanded; the rest are counted. When no detailed status exists,
the error says so and suggests a smaller radius or a different selection.

The chamfer builder exposes no equivalent stripe failure status. Its error reports the requested
distance and contour count, and suggests reducing the distance or changing the selection without
pretending to determine the exact cause. Neither operation accepts null or invalid output geometry.
Errors follow the existing Result/error-string path into feature diagnostics and MCP responses;
saved feature payloads are unchanged.
