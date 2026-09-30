/**
 * Maximum number of rows one `IndexedDBStorage` scan page reads inside a single
 * readonly transaction before buffering them and yielding to the consumer.
 *
 * Internal tuning constant: deliberately not exported from the package barrels
 * and not a public `ScanOptions` field.
 */
export const SCAN_PAGE_SIZE = 100;
