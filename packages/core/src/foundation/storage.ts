// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface IStorage {
    createDBIfNeeded(database: string, tables: string[]): Promise<void>;
    get(database: string, table: string, id: string): Promise<any>;
    put(database: string, table: string, id: string, value: any): Promise<boolean>;
    delete(database: string, table: string, id: string): Promise<boolean>;
    page(database: string, table: string, page: number): Promise<any[]>;
}
