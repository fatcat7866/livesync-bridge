import { minimatch } from "minimatch";

// Ignore patterns are matched with minimatch, the same matcher the CouchDB peer uses
// for `includeInternal`. `dot` is needed because the directories which are worth
// ignoring at all are usually dot-directories, such as `.git`.
export const IGNORE_MATCH_OPTIONS = { dot: true } as const;

// The configured patterns, plus the bare directory form of every `dir/**` pattern.
// `**/.git/**` matches everything inside `.git` but not `.git` itself, and the
// directory itself is exactly what has to be recognised to stay out of the tree.
// As a consequence a trailing `/**` also covers the entry with that name.
export function expandIgnorePatterns(configured: string[]): string[] {
    const directories = configured
        .filter((pattern) => pattern.endsWith("/**"))
        .map((pattern) => pattern.slice(0, -"/**".length));
    return [...configured, ...directories];
}

// Whether a peer-relative POSIX path is excluded by already-expanded patterns.
// A path is also excluded when any of its ancestor directories is: the scans
// prune an ignored directory, so live events for its descendants have to be
// dropped as well, even when a pattern such as `private` or `*.tmp` only
// matches the directory itself.
export function isIgnoredByPatterns(path: string, patterns: string[]): boolean {
    if (!path) return false;
    if (patterns.length === 0) return false;
    // Patterns are written in NFC; a path that arrives decomposed (NFD, as macOS
    // file names often are) must be judged the same, or an allowed file is dropped.
    const segments = path.normalize("NFC").split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
        const candidate = segments.slice(0, depth).join("/");
        if (patterns.some((pattern) => minimatch(candidate, pattern, IGNORE_MATCH_OPTIONS))) {
            return true;
        }
    }
    return false;
}
