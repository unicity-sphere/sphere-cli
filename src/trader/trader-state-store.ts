/**
 * Trader Agent — persistent state store.
 *
 * Persists intents, deals, and strategy to disk using atomic writes
 * (write to temp file, then `fs.rename`) so a crash mid-write cannot
 * corrupt state. No auto-save: callers invoke `save()` explicitly at
 * well-defined checkpoints.
 *
 * BigInt-bearing fields (volumes, rates) round-trip via a `"n:"`-prefixed
 * string encoding since `JSON.stringify` refuses native bigints.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  DealRecord,
  IntentRecord,
  IntentState,
  TraderStrategy,
} from './types.js';
import { DEFAULT_STRATEGY } from './types.js';

// =============================================================================
// On-disk schema
// =============================================================================

interface PersistedState {
  readonly version: 1;
  readonly intents: Record<string, IntentRecord>;
  readonly deals: Record<string, DealRecord>;
  readonly strategy: TraderStrategy;
}

// =============================================================================
// BigInt JSON round-trip helpers
// =============================================================================

/**
 * JSON.stringify replacer: encodes `bigint` values as `"n:<decimal>"`.
 * Strings that happen to begin with `"n:"` are left untouched on the way
 * out — the reviver only decodes values whose original runtime type was
 * bigint, so there is no ambiguity for intent/deal payloads where the
 * bigint fields are typed and known.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `n:${value.toString()}` : value;
}

/**
 * JSON.parse reviver: decodes `"n:<decimal>"` strings back to `bigint`.
 * Any other string is returned unchanged.
 */
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('n:')) {
    return BigInt(value.slice(2));
  }
  return value;
}

// =============================================================================
// Store
// =============================================================================

export class TraderStateStore {
  private readonly filePath: string;
  private readonly intents: Map<string, IntentRecord>;
  private readonly deals: Map<string, DealRecord>;
  private strategy: TraderStrategy;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'wallet', 'trader', 'state.json');
    this.intents = new Map();
    this.deals = new Map();
    this.strategy = DEFAULT_STRATEGY;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Load persisted state from disk. If the file does not exist, the store is
   * initialised with empty maps and the default strategy. A parse failure
   * (corrupt file) is raised to the caller — silently wiping state on corrupt
   * JSON would mask real problems.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.intents.clear();
        this.deals.clear();
        this.strategy = DEFAULT_STRATEGY;
        return;
      }
      throw err;
    }

    let parsed: PersistedState;
    try {
      parsed = JSON.parse(raw, bigintReviver) as PersistedState;
    } catch (err) {
      throw new Error(
        `TraderStateStore: failed to parse state file ${this.filePath}: ${(err as Error).message}`,
      );
    }

    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      throw new Error(
        `TraderStateStore: unsupported state file version in ${this.filePath}`,
      );
    }

    this.intents.clear();
    for (const [id, rec] of Object.entries(parsed.intents ?? {})) {
      this.intents.set(id, rec);
    }

    this.deals.clear();
    for (const [id, rec] of Object.entries(parsed.deals ?? {})) {
      this.deals.set(id, rec);
    }

    this.strategy = parsed.strategy ?? DEFAULT_STRATEGY;
  }

  /**
   * Persist the entire state atomically: write to a temp file, then rename
   * over the target. `fs.rename` is atomic within a filesystem on POSIX, so
   * a crash either leaves the old file intact or the new file in place —
   * never a half-written file.
   */
  async save(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      intents: Object.fromEntries(this.intents),
      deals: Object.fromEntries(this.deals),
      strategy: this.strategy,
    };
    const json = JSON.stringify(state, bigintReplacer, 2);
    const tmpPath = this.filePath + '.tmp';
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmpPath, json, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  // ---------------------------------------------------------------------------
  // Intent CRUD
  // ---------------------------------------------------------------------------

  getIntent(intentId: string): IntentRecord | undefined {
    return this.intents.get(intentId);
  }

  getAllIntents(): IntentRecord[] {
    return Array.from(this.intents.values());
  }

  getIntentsByState(state: IntentState): IntentRecord[] {
    const out: IntentRecord[] = [];
    for (const rec of this.intents.values()) {
      if (rec.state === state) {
        out.push(rec);
      }
    }
    return out;
  }

  setIntent(record: IntentRecord): void {
    this.intents.set(record.intent.intent_id, record);
  }

  deleteIntent(intentId: string): void {
    this.intents.delete(intentId);
  }

  // ---------------------------------------------------------------------------
  // Deal CRUD
  // ---------------------------------------------------------------------------

  getDeal(dealId: string): DealRecord | undefined {
    return this.deals.get(dealId);
  }

  getAllDeals(): DealRecord[] {
    return Array.from(this.deals.values());
  }

  /**
   * Return every deal that references `intentId` on either side of the
   * terms — proposer or acceptor. Callers filter further by `role` or
   * `state` as needed.
   */
  getDealsByIntentId(intentId: string): DealRecord[] {
    const out: DealRecord[] = [];
    for (const deal of this.deals.values()) {
      if (
        deal.terms.proposer_intent_id === intentId ||
        deal.terms.acceptor_intent_id === intentId
      ) {
        out.push(deal);
      }
    }
    return out;
  }

  setDeal(record: DealRecord): void {
    this.deals.set(record.deal_id, record);
  }

  // ---------------------------------------------------------------------------
  // Strategy
  // ---------------------------------------------------------------------------

  getStrategy(): TraderStrategy {
    return this.strategy;
  }

  setStrategy(strategy: TraderStrategy): void {
    this.strategy = strategy;
  }
}
