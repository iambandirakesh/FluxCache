/**
 * Deterministic in-memory API used by the example.
 * No credentials, no network, no external services.
 */

export type Account = 'alice' | 'bob';

export interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
}

const LATENCY_MS = 320;

const CATALOG: Record<Account, Product[]> = {
  alice: [
    {
      id: 'a1',
      name: 'Aurora Lamp',
      price: 89,
      description: 'A warm dimmable desk lamp with a brushed brass arm.',
    },
    {
      id: 'a2',
      name: 'Cedar Desk',
      price: 420,
      description: 'Solid cedar writing desk with two shallow drawers.',
    },
    {
      id: 'a3',
      name: 'Slate Notebook',
      price: 18,
      description: 'Dot-grid notebook with a stone-grey linen cover.',
    },
    {
      id: 'a4',
      name: 'Fog Ceramic Mug',
      price: 26,
      description: 'Hand-thrown stoneware mug in a matte fog glaze.',
    },
  ],
  bob: [
    {
      id: 'b1',
      name: 'Alpine Backpack',
      price: 156,
      description: '35L roll-top pack with a waterproof liner.',
    },
    {
      id: 'b2',
      name: 'Trail Bottle',
      price: 34,
      description: 'Insulated steel bottle that fits a bicycle cage.',
    },
    {
      id: 'b3',
      name: 'Ridge Beanie',
      price: 29,
      description: 'Merino beanie knitted for cold mornings.',
    },
  ],
};

let account: Account = 'alice';
let failNextRequest = false;
let requestCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setAccount(next: Account): void {
  account = next;
}

export function getAccount(): Account {
  return account;
}

export function getProductIds(): string[] {
  return CATALOG[account].map((product) => product.id);
}

export function setFailNextRequest(value: boolean): void {
  failNextRequest = value;
}

export function getRequestCount(): number {
  return requestCount;
}

export function subscribeToRequestCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The request was aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('The request was aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function simulate<T>(signal: AbortSignal | undefined, produce: () => T): Promise<T> {
  requestCount += 1;
  notify();
  await delay(LATENCY_MS, signal);
  if (failNextRequest) {
    failNextRequest = false;
    throw new Error('Simulated 500 from the mock API (the next request will succeed)');
  }
  return produce();
}

export async function fetchProducts(options: { signal?: AbortSignal } = {}): Promise<Product[]> {
  return simulate(options.signal, () => CATALOG[account].map((product) => ({ ...product })));
}

export async function fetchProduct(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Product> {
  return simulate(options.signal, () => {
    const product = CATALOG[account].find((candidate) => candidate.id === id);
    if (!product) throw new Error(`Product "${id}" does not exist for ${account}`);
    return { ...product };
  });
}

/** Local mutation helper. The UI then invalidates the affected query keys. */
export function renameProduct(id: string, name: string): void {
  const product = CATALOG[account].find((candidate) => candidate.id === id);
  if (product) product.name = name;
}
