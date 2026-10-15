// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Only ever loaded with a dynamic `import()` (TelemetryController's loader in the builder), once the
// user switched telemetry on with a collector URL.
export { startOtelTelemetry } from "./otel";
