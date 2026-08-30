import { SessionPool, defaultSessionPool } from "./pool.ts";
import { TicketRegistry, ticketRegistry } from "./tickets.ts";

/**
 * Injectable runtime context for one delegate extension lifetime.
 *
 * A runtime bundles a {@link SessionPool} and a {@link TicketRegistry} so
 * tests and nested callers can create fully isolated dispatch/lifecycle
 * environments without touching the module-level default pool or ticket
 * registry. Production Pi uses the single default runtime returned by
 * {@link getDefaultDelegateRuntime}; the public barrel still exposes the
 * familiar checkout/commit/ticket wrapper functions for compatibility.
 */
export interface DelegateRuntime {
  pool: SessionPool;
  tickets: TicketRegistry;
}

/** Create a fresh, isolated runtime with its own pool and ticket registry. */
export function createDelegateRuntime(): DelegateRuntime {
  return {
    pool: new SessionPool(),
    tickets: new TicketRegistry(),
  };
}

const defaultRuntime: DelegateRuntime = {
  pool: defaultSessionPool,
  tickets: ticketRegistry,
};

/** The runtime used by the one-argument Pi extension entry point and the
 *  default-runtime compatibility wrappers exported from the barrel. */
export function getDefaultDelegateRuntime(): DelegateRuntime {
  return defaultRuntime;
}
