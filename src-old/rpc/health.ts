import type {
  ChainName,
} from "../chains/definitions.js";

import {
  RpcManager,
} from "./manager.js";

export async function getHealthyRpc(
  manager: RpcManager,
  chain: ChainName,
) {
  try {
    return await manager.getBest(chain);
  } catch {
    /*
     * Refresh toàn bộ RPC nếu
     * endpoint trước đó đã chết.
     */
    await manager.checkChain(chain);

    return manager.getBest(chain);
  }
}