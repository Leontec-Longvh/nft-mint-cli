# nft-mint-cli

CLI tối ưu latency cho các đợt mint NFT FCFS/allowlist cạnh tranh trên các
chain EVM tương thích OpenSea/SeaDrop (Robinhood Chain, Arc, Ink, và các
chain OpenSea hỗ trợ khác).

Mục tiêu: từ lúc phase mở tới lúc transaction được include on-chain — tính
bằng block, không phải giây.

## Kiến trúc & quy ước

- **Core (đóng băng — không sửa)**: `src/cli.ts`, `src/mint-engine.ts`,
  `src/broadcast.ts`, `src/opensea.ts`. Mọi tool mới đều là **cộng thêm**,
  không được đụng vào các file này.
- **Tool phụ**: nằm trong `src/tools/`.
- **Config**: mỗi collection có 1 file `<slug>.config.json` đặt ở **project
  root**, cạnh `package.json` (ví dụ `arc-tellers.config.json`,
  `goose-origami.config.json`). Đây là "giao diện chung" giữa các tool.

## Cài đặt

```bash
npm install
```

Tạo file `.env` ở project root (xem `.env.example`):

```
PRIVATE_KEY=0x...          # phải khớp đúng địa chỉ --wallet, nếu không cli.ts sẽ throw
OPENSEA_API_KEY=...
EXTRA_RPC_URLS=            # tuỳ chọn, comma-separated, thêm RPC dự phòng để broadcastRace đua nhiều đường hơn
```

## Chain hỗ trợ (`src/chains.ts`)

| Tên       | Chain ID | Ghi chú                                  |
|-----------|----------|-------------------------------------------|
| ethereum  | 1        |                                            |
| base      | 8453     |                                            |
| polygon   | 137      |                                            |
| arbitrum  | 42161    |                                            |
| optimism  | 10       |                                            |
| zora      | 7777777  |                                            |
| robinhood | 4663     | ~0.1s block time                           |
| ink       | 10001    |                                            |
| arc       | 5042     | Circle Arc — gas trả bằng USDC, native 18 decimals |

Thêm chain mới: chỉ sửa `src/chains.ts` (không phải file core bị đóng băng ở
trên), khai báo `chain` + `rpcUrls`.

---

## 1. Chạy trực tiếp `cli.ts` (thấp cấp nhất, biết trước mọi tham số)

```bash
npx tsx src/cli.ts \
  --slug <slug> \
  --chain-id <chainId> \
  --wallet <address> \
  --quantity 1 \
  --gas-limit <n> \
  --confirm
```

- `--gas-limit` **nên luôn truyền tay** khi thật sự chạy FCFS — nếu bỏ qua,
  `cli.ts` sẽ tự `eth_estimateGas()` một lần ngay trước hot window, tốn thêm
  thời gian và có rủi ro nếu ví chưa eligible cho phase đang active (xem mục
  cảnh báo bên dưới).
- Bỏ `--confirm` để chạy dry-run (không ký/không broadcast).

## 2. `src/tools/mint-preset.ts` — discovery (chỉ chạy 1 lần cho mỗi drop mới)

Gọi OpenSea 1 lần để lấy contract + toàn bộ lịch phase, ghi ra
`<slug>.config.json`, kiểm tra eligibility, rồi (nếu có `--confirm`) tự
handoff sang `cli.ts`.

```bash
npx tsx src/tools/mint-preset.ts \
  --slug <slug> \
  --wallet <address> \
  --chain-id <chainId> \
  [--quantity <n>] \
  [--gas-limit <n>] \
  [--check-only]   # chỉ ghi config + báo eligibility, KHÔNG mint
  [--confirm]       # forward sang cli.ts, thực sự mint
```

Ví dụ:

```bash
npx tsx src/tools/mint-preset.ts --slug arc-tellers --wallet 0xA519... --chain-id 5042 --confirm
```

⚠️ Nếu không truyền `--gas-limit`, engine sẽ thử `eth_estimateGas` một lần
dựa trên phase đang **active** lúc đó — nếu ví bạn không eligible phase đó
(422), bước estimate này sẽ **crash toàn bộ tiến trình**, kể cả khi có một
phase khác (vd FCFS) sắp mở mà bạn hoàn toàn eligible. Luôn chạy
`gas-preestimate.ts` (mục 4) trước, hoặc tự truyền `--gas-limit` thủ công.

## 3. `src/mint-preset.ts` — chạy lại từ config có sẵn (dùng hằng ngày)

Không gọi OpenSea để lấy contract/phase nữa (đỡ tốn request) — chỉ đọc
`<slug>.config.json` đã có (do tool ở mục 2 tạo ra, hoặc tự viết tay), build
đúng argv rồi spawn `cli.ts`.

```bash
npx tsx src/mint-preset.ts <slug> [overrides...]
```

Ví dụ:

```bash
npx tsx src/mint-preset.ts arc-tellers --confirm
npx tsx src/mint-preset.ts arc-tellers --confirm --gas-limit 220000   # ghi đè tạm, không sửa file
npx tsx src/mint-preset.ts arc-tellers --quantity 2 --no-confirm      # dry-run, quantity khác
```

Override flags hỗ trợ: `--slug --chain-id --wallet --quantity --gas-limit
--confirm --no-confirm`. Override **luôn thắng** giá trị trong file, chỉ áp
dụng cho lần chạy đó — file gốc không bị sửa.

Format file `<slug>.config.json`:

```json
{
  "slug": "arc-tellers",
  "chainId": 5042,
  "wallet": "0x...",
  "quantity": 1,
  "gasLimit": 336000,
  "confirm": true
}
```

(File do tool ở mục 2 tạo ra có thêm vài field khác như `contractAddress`,
`stages`, `preparedAt` — không sao, `mint-preset.ts` chỉ đọc field nó cần và
bỏ qua phần còn lại.)

## 4. `src/tools/gas-preestimate.ts` — ước lượng gas an toàn, trước hot window

Tool **read-only tuyệt đối** — không bao giờ ký hay broadcast bất cứ gì.
Dùng để có sẵn `--gas-limit` trước khi FCFS mở, tránh phải `eth_estimateGas`
ngay trong hot window.

```bash
npx tsx src/tools/gas-preestimate.ts \
  --slug <slug> \
  --chain-id <chainId> \
  --wallet <address> \
  [--quantity <n>] \
  [--safety <percent>]   # mặc định 50
  [--round <gas>]        # mặc định 1000, làm tròn lên
```

Cách hoạt động, theo thứ tự ưu tiên:

1. **Calldata thật của chính `--wallet`** cho phase đang active — chính xác
   nhất, dùng khi ví bạn eligible ngay bây giờ.
2. **Auto-probe**: nếu `--wallet` bị OpenSea từ chối (422 "not eligible"),
   tool tự gọi OpenSea Events API để tìm vài ví **thật vừa mint thành công**
   trên chính collection này, mượn calldata của họ (chỉ để simulate gas —
   không cần private key của họ, không ký gì cả) để `eth_estimateGas`.
   - Nếu gặp lỗi **cấp phase** (`"fully minted out"` / `"sold out"` — tức
     phase hết suất cho *mọi người*, không riêng ví nào), tool dừng probe
     ngay lập tức thay vì thử phí phạm hết danh sách ứng viên.
3. **Historical fallback (tự động)**: cùng những mint event tìm được ở bước
   2 đã có sẵn transaction hash — tool tự đọc `gasUsed` **thật** từ receipt
   on-chain của các tx đó. Không cần bạn tự tạo file gì.
4. **Historical fallback (thủ công, tuỳ chọn)**: nếu muốn bổ sung thêm
   nguồn, tạo `gas-reference.json` ở project root:
   ```json
   { "arc-tellers": { "transactions": [{ "hash": "0x..." }] } }
   ```
   Các tham chiếu ở đây được cộng dồn thêm vào bước 3, không thay thế.

Sau khi có kết quả (bất kể từ nguồn nào ở trên), tool **tự động lưu**
`gasLimit` khuyến nghị vào `<slug>.config.json` **nếu file đó đã tồn tại**
(không tự tạo file mới) — để lần chạy `mint-preset.ts <slug> --confirm` sau
đó dùng luôn, không cần gõ thêm `--gas-limit`.

---

## Quy trình chuẩn cho 1 drop mới

```bash
# 1. Discovery — lấy contract + lịch phase, ghi config
npx tsx src/tools/mint-preset.ts --slug <slug> --wallet <address> --chain-id <chainId> --check-only

# 2. Ước lượng gas an toàn, tự lưu vào <slug>.config.json
npx tsx src/tools/gas-preestimate.ts --slug <slug> --chain-id <chainId> --wallet <address>

# 3. Launch thật — đợi đúng phase, gas-limit đã có sẵn trong config
npx tsx src/mint-preset.ts <slug> --confirm
```

## Windows

`npx`/`npm` được spawn với `process.platform === "win32"` detection +
`shell: true` để resolve đúng `npx.cmd` — không cần chỉnh gì thêm khi chạy
trên Windows.


---

## 5. `src/tools/send-tokens.ts` — gửi ETH hoặc token ERC-20 cho nhiều ví

Gửi native token hoặc bất kỳ ERC-20 nào cho 1 hoặc nhiều ví, số lượng khác
nhau theo file config. Không cần biết contract address hay decimals —
chỉ cần gõ **symbol** ("ETH", "USDT", ...), tool tự tra `tokens.config.json`
và tự đọc `decimals()` on-chain.

```bash
npx tsx src/tools/send-tokens.ts --config send.config.json [--dry-run]
```

Format `send.config.json`:

```json
{
  "chainId": 4663,
  "token": "USDT",
  "recipients": [
    { "address": "0x...", "amount": "100" },
    { "address": "0x...", "amount": "42.5" }
  ]
}
```

Registry symbol → contract address (`tokens.config.json` ở project root, cấu
hình 1 lần):

```json
{ "USDT": "0x...", "USDC": "0x..." }
```

`"token": "ETH"` (hoặc "NATIVE") gửi native currency của chain, không cần
registry. Dùng `--dry-run` để xem trước, không broadcast.

## 6. `src/tools/nft-sender.ts` — gửi NFT (ERC-721/1155) cho nhiều ví

Gửi các NFT ví đang sở hữu sẵn tới nhiều ví khác nhau (không mint). Hỗ trợ
cả ERC-721 và ERC-1155.

```bash
npx tsx src/tools/nft-sender.ts --config nft-send.config.json [--dry-run]
```

Format `nft-send.config.json`:

```json
{
  "chainId": 4663,
  "nftAddress": "0x...",
  "tokenType": "ERC721",
  "transfers": [
    { "to": "0x...", "tokenId": "101" },
    { "to": "0x...", "tokenId": "102" }
  ]
}
```

Cả 2 tool dùng chung `PRIVATE_KEY`/`EXTRA_RPC_URLS`/`GAS_BUFFER_PERCENT`
trong `.env` sẵn có, và cùng hạ tầng (`chains.ts`, `broadcast.ts`) với
`cli.ts` — không cần cấu hình thêm gì. `--chain-id` trên CLI override được
`chainId` trong config nếu cần đổi chain tạm thời.