# Presets

Mỗi file `.json` trong thư mục này là 1 bộ tham số cho 1 lần mint, để khỏi phải
gõ lệnh dài mỗi lần chạy.

## Chạy

```bash
npx tsx src/mint-preset.ts <tên-preset>
```

Ví dụ, với `presets/robominttest.json`:

```bash
npx tsx src/mint-preset.ts robominttest
```

Lệnh trên tương đương hệt với:

```bash
npx tsx src/cli.ts --slug robominttest --chain-id 4663 --wallet 0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16 --quantity 1 --gas-limit 180000 --confirm
```

## Ghi đè tạm thời (không sửa file preset)

```bash
npx tsx src/mint-preset.ts robominttest --quantity 2
npx tsx src/mint-preset.ts robominttest --no-confirm
```

## Format file preset

```json
{
  "slug": "robominttest",       // bắt buộc — slug collection trên OpenSea
  "chainId": 4663,              // bắt buộc — chain ID
  "wallet": "0x...",            // bắt buộc — ví mint (phải khớp PRIVATE_KEY trong .env)
  "quantity": 1,                // tuỳ chọn, mặc định 1
  "gasLimit": 180000,           // tuỳ chọn — nên set từ kết quả src/tools/gas-preestimate.ts
  "confirm": true               // tuỳ chọn — true = bắn thật, false/bỏ qua = dry-run
}
```

`gasLimit` nên lấy từ:

```bash
npx tsx src/tools/gas-preestimate.ts --slug <slug> --chain-id <chainId> --wallet <address>
```

Tool đó không đụng vào `cli.ts` / `mint-engine.ts` / `broadcast.ts`, chỉ ước
lượng gas qua mọi RPC rồi in sẵn `--gas-limit` khuyến nghị (đã cộng safety
margin) và cả câu lệnh đầy đủ để copy.