// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    AsyncController,
    type EditableShapeNode,
    type IApplication,
    type IDocument,
    PubSub,
    Result,
    SvgImportRoute,
    type SvgShapeOptions,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { ImportSvg } from "../../src/commands/importExport";

const originalCreateElement = document.createElement;

/** The next file input "selects" `files` when clicked. */
function selectOnClick(files: File[]) {
    const create = originalCreateElement.bind(document) as (tag: string) => HTMLElement;
    document.createElement = ((tag: string) => {
        const element = create(tag);
        if (tag === "input") {
            const input = element as HTMLInputElement;
            input.click = () => {
                Object.defineProperty(input, "files", { value: files, configurable: true });
                input.onchange?.(new Event("change"));
            };
        }
        return element;
    }) as typeof document.createElement;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
    <rect x="0" y="0" width="40" height="20"/></svg>`;

function setup() {
    const importSvg = rs.fn(async (_document: IDocument, _file: File, _options?: SvgShapeOptions) =>
        Result.ok({} as EditableShapeNode),
    );
    const document = createMockDocument();
    const fitContent = rs.fn();
    const application = createMockApplication({ dataExchange: { importSvg } }) as IApplication;
    (application as { activeView: unknown }).activeView = { document, cameraController: { fitContent } };
    return { application, document, importSvg, fitContent };
}

/** Lets the command read the file and open its options (it then waits for confirm/cancel). */
async function untilWaiting(command: ImportSvg) {
    for (let i = 0; i < 50 && !(command as unknown as { controller?: unknown }).controller; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect((command as unknown as { controller?: unknown }).controller).toBeInstanceOf(AsyncController);
}

afterEach(() => {
    document.createElement = originalCreateElement;
    rs.restoreAllMocks();
});

describe("ImportSvg", () => {
    test("has command metadata", () => {
        expect((ImportSvg as any).prototype.data.key).toBe("file.importSvg");
    });

    test("shows the drawing's size, rescales from an edited width and imports on confirm", async () => {
        const { application, document, importSvg, fitContent } = setup();
        selectOnClick([new File([SVG], "logo.svg")]);
        const command = new ImportSvg();
        command.scale = 1;
        command.faces = true;
        const running = command.execute(application);
        await untilWaiting(command);
        expect(command.width).toBeCloseTo(40);
        expect(command.height).toBeCloseTo(20);

        command.width = 100;
        expect(command.scale).toBeCloseTo(2.5);
        expect(command.height).toBeCloseTo(50);
        command.width = -1;
        expect(command.width).toBeCloseTo(100);
        command.height = 0;
        expect(command.height).toBeCloseTo(50);
        command.confirm();
        await running;

        expect(importSvg).toHaveBeenCalledTimes(1);
        const [target, file, options] = importSvg.mock.calls[0];
        expect(target).toBe(document);
        expect(file.name).toBe("logo.svg");
        expect(options?.scale).toBeCloseTo(2.5);
        expect(options?.faces).toBe(true);
        expect(fitContent).toHaveBeenCalled();
    });

    test("hands over to the routed command without reading a file", async () => {
        const { application, importSvg } = setup();
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        const click = rs.fn();
        const create = originalCreateElement.bind(document) as (tag: string) => HTMLElement;
        document.createElement = ((tag: string) => {
            const element = create(tag);
            if (tag === "input") (element as HTMLInputElement).click = click;
            return element;
        }) as typeof document.createElement;
        SvgImportRoute.redirect = () => "sketch.importSvg";
        try {
            await new ImportSvg().execute(application);
            expect(pub).not.toHaveBeenCalledWith("executeCommand", "sketch.importSvg");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(pub).toHaveBeenCalledWith("executeCommand", "sketch.importSvg");
            expect(click).not.toHaveBeenCalled();
            expect(importSvg).not.toHaveBeenCalled();
        } finally {
            SvgImportRoute.redirect = undefined;
        }
    });

    test.each([0, -2, Number.NaN])("an invalid scale of %d is ignored", (value) => {
        const command = new ImportSvg();
        command.scale = 3;
        expect(command.scale).toBe(3);
        command.scale = value;
        expect(command.scale).toBe(3);
    });

    test("cancel imports nothing", async () => {
        const { application, importSvg } = setup();
        selectOnClick([new File([SVG], "logo.svg")]);
        const command = new ImportSvg();
        const running = command.execute(application);
        await untilWaiting(command);
        await Promise.all([command.cancel(), running]);
        expect(importSvg).not.toHaveBeenCalled();
    });

    test("a file without outlines is reported and never reaches the importer", async () => {
        const { application, importSvg } = setup();
        const pub = rs.spyOn(PubSub.default, "pub");
        selectOnClick([new File(['<svg xmlns="http://www.w3.org/2000/svg"><text>a</text></svg>'], "t.svg")]);
        await new ImportSvg().execute(application);
        expect(pub).toHaveBeenCalledWith(
            "showToast",
            "error.import.svg:{0}",
            "The SVG file has no outlines to import",
        );
        expect(importSvg).not.toHaveBeenCalled();
    });
});
