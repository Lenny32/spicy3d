// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CollectionChangedArgs, ObservableCollection } from "../src";

describe("ObservableCollection test", () => {
    test("should notify when items are added", () => {
        const collection = new ObservableCollection<number>();
        let received: CollectionChangedArgs | undefined;
        collection.onCollectionChanged((arg: CollectionChangedArgs) => {
            received = arg;
        });
        collection.push(1);
        expect(received).not.toBeNull();
        expect(received!.action).toBe("add");
        const args = received as Extract<CollectionChangedArgs, { action: "add" }>;
        expect(args.items.length).toBe(1);
    });

    test("should notify when items are removed", () => {
        const collection = new ObservableCollection<number>(1, 2, 3);
        let received: CollectionChangedArgs | undefined;
        collection.onCollectionChanged((arg: CollectionChangedArgs) => {
            received = arg;
        });
        collection.remove(1, 3);
        expect(received).not.toBeNull();
        expect(received!.action).toBe("remove");
        const args = received as Extract<CollectionChangedArgs, { action: "remove" }>;
        expect(args.items).toStrictEqual([1, 3]);
        expect(args.items.length).toBe(2);
    });

    test("should notify when an item is moved", () => {
        const collection = new ObservableCollection<number>(1, 2, 3);
        let received: CollectionChangedArgs | undefined;
        collection.onCollectionChanged((arg: CollectionChangedArgs) => {
            received = arg;
        });
        collection.move(0, 2);
        expect(received).not.toBeNull();
        expect(received!.action).toBe("move");
        const args = received as Extract<CollectionChangedArgs, { action: "move" }>;
        expect(collection.items()).toStrictEqual([2, 1, 3]);
        expect(collection.items().length).toBe(3);
        expect(args.from).toBe(0);
        expect(args.to).toBe(2);
    });

    test("should notify when an item is replaced", () => {
        const collection = new ObservableCollection<number>(1, 2, 3);
        let received: CollectionChangedArgs | undefined;
        collection.onCollectionChanged((arg: CollectionChangedArgs) => {
            received = arg;
        });
        collection.replace(1, 3, 2);
        expect(received).not.toBeNull();
        expect(received!.action).toBe("replace");
        const args = received as Extract<CollectionChangedArgs, { action: "replace" }>;
        expect(collection.items()).toStrictEqual([1, 3, 2, 3]);
        expect(args.items).toStrictEqual([3, 2]);
        expect(args.items.length).toBe(2);
        expect(args.item).toBe(2);
    });
});
