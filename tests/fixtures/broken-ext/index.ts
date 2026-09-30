/**
 * Broken provider-extension fixture (#59 contract tests). Module
 * evaluation throws, so the child resource loader records a load error
 * for this root — a user-configured (required) root must then fail the
 * task closed rather than run without the configured integration.
 */
throw new Error("BROKEN-EXTENSION-FIXTURE");
