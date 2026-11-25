import fs from 'fs';
import { logger } from '../helpers/logger';

export class CreatorBlacklist {
  private mtime = -1;
  private values = new Set<string>();

  constructor(private readonly file: string) {}

  has(creator: string): boolean {
    this.refresh();
    return this.values.has(creator);
  }

  private refresh() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.mtimeMs === this.mtime) {
        return;
      }
      const data = fs.readFileSync(this.file, 'utf8');
      this.values = new Set(
        data
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#')),
      );
      this.mtime = stat.mtimeMs;
      logger.info(`Loaded ${this.values.size} blacklisted pump creators`);
    } catch {
      this.values = new Set();
      this.mtime = -1;
    }
  }
}

interface MintFlow {
  buyers: Set<string>;
  buys: number;
  sells: number;
  createSlot: number;
  buySlots: number[];
}

export class BuyerTracker {
  private readonly byMint = new Map<string, MintFlow>();
  private readonly launchesByCreator = new Map<string, number>();

  noteCreate(mint: string, creator: string, slot: number) {
    const flow = this.flow(mint);
    flow.createSlot = slot;
    this.launchesByCreator.set(creator, (this.launchesByCreator.get(creator) ?? 0) + 1);
  }

  record(mint: string, user: string, isBuy = true, slot = 0) {
    const flow = this.flow(mint);
    if (isBuy) {
      flow.buys += 1;
      flow.buyers.add(user);
      if (slot > 0 && flow.buySlots.length < 50) {
        flow.buySlots.push(slot);
      }
    } else {
      flow.sells += 1;
    }
  }

  count(mint: string): number {
    return this.byMint.get(mint)?.buyers.size ?? 0;
  }

  launches(creator: string): number {
    return this.launchesByCreator.get(creator) ?? 0;
  }

  /** Records the create slot without counting another launch. Used for PumpSwap pools. */
  noteSlot(mint: string, slot: number) {
    this.flow(mint).createSlot = slot;
  }

  stats(mint: string): { buys: number; sells: number; unique: number; sameSlotBuys: number; createSlot: number } {
    const flow = this.byMint.get(mint);
    if (!flow) {
      return { buys: 0, sells: 0, unique: 0, sameSlotBuys: 0, createSlot: 0 };
    }
    const sameSlotBuys = flow.createSlot > 0 ? flow.buySlots.filter((slot) => slot === flow.createSlot).length : 0;
    return {
      buys: flow.buys,
      sells: flow.sells,
      unique: flow.buyers.size,
      sameSlotBuys,
      createSlot: flow.createSlot,
    };
  }

  private flow(mint: string): MintFlow {
    let flow = this.byMint.get(mint);
    if (!flow) {
      flow = { buyers: new Set(), buys: 0, sells: 0, createSlot: 0, buySlots: [] };
      this.byMint.set(mint, flow);
    }
    return flow;
  }
}
