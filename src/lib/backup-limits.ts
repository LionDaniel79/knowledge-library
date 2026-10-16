// Local recovery allows the existing archive plus the 200 MiB cover quota.
// Leave room for the JSON request envelope. Cloud hosts can impose lower limits.
export const BACKUP_FILE_MAX = 511 * 1024 * 1024;
export const BACKUP_REQUEST_MAX = 512 * 1024 * 1024;
