# Icon inventory — emoji placeholders to replace with Lucide PNG icons

Ghi lại tất cả icon đang là **emoji ký tự** (không phải PNG) trong UI, để sau này tải PNG tương ứng
từ [Lucide](https://lucide.dev) thay thế. Cột "Lucide" là gợi ý tên icon, chưa chốt — chọn lúc thực
sự làm, không phải bây giờ.

## Popup (`ui/popup/views/list-view.ts`)

| Emoji | Dùng ở đâu | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ⬆ | nav, nút Upload script | Tải script lên | `upload` |
| ⟳ | nav, nút Refresh | Làm mới danh sách | `refresh-cw` |
| ⚙ | `module-gear` | Mở Management View (Collection schema) | `settings` |
| 👁 / 🙈 | `ui-valve` | Hiện/ẩn UI của module (§11.4) | `eye` / `eye-off` |
| ✏️ | lifecycle, nút Rename | Đổi tên script (§12.1) | `pencil` |
| ⬇️ | lifecycle, nút Download | Tải source script về (§12.1) | `download` |
| 🗑️ | lifecycle, nút Delete | Xoá script (§12.1) | `trash-2` |

## Popup (`ui/popup/views/action-result-view.ts`)

| Emoji | Dùng ở đâu | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ← | nút "← Back" | Quay lại danh sách | `arrow-left` |

## Dashboard (`ui/dashboard/views/management-view.ts`)

| Emoji | Dùng ở đâu | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ✎ | nút Edit mỗi row | Sửa item | `pencil` |
| ✕ | nút Delete mỗi row | Xoá item | `x` |

## Dashboard (`ui/dashboard/views/item-form-view.ts`)

| Emoji | Dùng ở đâu | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ⓘ | hover hint cạnh field có `field.hint` | Giải thích thêm | `info` |

## Side Panel (`ui/side-panel/main.ts`)

| Emoji | Dùng ở đâu | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| 📄 | section header "Reader Mode" | | `file-text` |
| 🎬 | section header "Media Sniffer" | | `clapperboard` |
| ⚙ | nút "Media Sniffer settings" | Mở Dashboard | `settings` |
| ▶ / ⏸ | nút Resume/Pause download | | `play` / `pause` |
| ⏹ | nút Stop (live capture) | | `square` |
| ✕ | nút đóng/dismiss | | `x` |
| ⚡ | prefix text "Turbo downloads" | Trang trí, không phải nút bấm | `zap` |

## On-page floating icon/badge (content scripts, world ISOLATED)

| Emoji | File | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ⬇ | `content-scripts/index.ts` (`showNetworkSnifferIcon`) | Icon nổi mở Side Panel khi phát hiện media | `download` |
| ⬇ | `features/media/dom-media-observer.content.ts` | Badge neo vào `<video>`/`<audio>` đã phát hiện | `download` |
| 📄 | `content-scripts/index.ts` (reader-mode icon `convert`) | Convert trang → Markdown | `file-text` |
| 🕸️ | `content-scripts/index.ts` (reader-mode icon `crawl`) | Crawl & convert cả site | `spider` (Lucide không có — cân nhắc `globe` hoặc `waypoints`) |

## Lưu ý khi thay

- PNG là file asset thật (không phải inline như emoji) → cần một đường dẫn thật (`chrome-extension://…/assets/icons/…`). `web_accessible_resources` đã có sẵn entry `assets/*` cho `<all_urls>` (xem `manifest.config.ts`) nên không cần khai thêm, miễn file nằm dưới `assets/`.
- Icon nổi/badge trên trang (`snifferUi.icon`/`ui.badge`, world ISOLATED, Shadow DOM qua `in-page-ui-engine`) dùng chung được `<img src="chrome-extension://…">` với icon trong popup/dashboard/side-panel (extension pages) — cùng một file PNG, không cần bản riêng cho từng context.
- PNG không tự scale theo DPI như SVG — cân nhắc tải kèm bản @2x (hoặc thẳng kích thước lớn rồi set `width`/`height` qua CSS) để không vỡ nét trên màn hình retina; Lucide cho chọn size lúc export.
- `title`/`aria-label` hiện tại đã có ở hầu hết chỗ dùng (bảng trên) — giữ nguyên khi đổi sang PNG (`<img alt="...">` hoặc `title` trên `button`), đừng để mất accessibility label chỉ vì đổi từ emoji (vốn tự có nghĩa) sang ảnh (cần alt text tường minh).
