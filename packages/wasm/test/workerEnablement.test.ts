// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig } from "@spicy3d/core";
import { OccShapeProvider } from "../src/shapeProvider";

afterEach(() => {
    DeploymentConfig.reset();
    rs.unstubAllGlobals();
});

test.each([
    undefined,
    false,
    "true",
    1,
    {},
    true,
])("deployment geometryWorker=%j is strictly opt-in", (value) => {
    const worker = rs.fn();
    rs.stubGlobal("Worker", worker);
    DeploymentConfig.set({ performance: { geometryWorker: value } });
    expect(new OccShapeProvider().factory.asyncOperations !== undefined).toBe(value === true);
    expect(worker).not.toHaveBeenCalled(); // Installing the capability must not eagerly allocate a kernel.
});

test("the default is main-thread scheduling, even when Worker exists", () => {
    rs.stubGlobal("Worker", rs.fn());
    expect(new OccShapeProvider().factory.asyncOperations).toBeUndefined();
});

test("explicit provider options override deployment opt-in, but require Worker support", () => {
    rs.stubGlobal("Worker", rs.fn());
    DeploymentConfig.set({ performance: { geometryWorker: true } });
    expect(new OccShapeProvider({ geometryWorker: false }).factory.asyncOperations).toBeUndefined();
    DeploymentConfig.reset();
    expect(new OccShapeProvider({ geometryWorker: true }).factory.asyncOperations).not.toBeUndefined();
    rs.stubGlobal("Worker", undefined);
    expect(new OccShapeProvider({ geometryWorker: true }).factory.asyncOperations).toBeUndefined();
});
