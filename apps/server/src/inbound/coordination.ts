import { Semaphore } from "effect";
import type { StoreService } from "../store.js";

const locks = new WeakMap<StoreService, Semaphore.Semaphore>();
export function inboundLock(store: StoreService) {
  let lock = locks.get(store);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(store, lock);
  }
  return lock.withPermits(1);
}
