# Icon inventory — emoji placeholders replaced with Lucide PNG icons

Trạng thái: **popup/dashboard/side-panel/Studio (extension pages) đã xong** — icon nạp qua
[`ui/icon.ts`](../src/adapters/browser-extension/ui/icon.ts), một registry `import` tĩnh duy nhất
từ `src/assets/icon/*.png` dùng chung cho cả bốn. **Icon nổi/badge trên trang (network-sniffer,
reader-mode) vẫn còn emoji** — xem phần cuối, đây là quyết định riêng chưa chốt vì nó đụng bề mặt
công khai `synapseApi.ui.*`.

## Popup (`ui/popup/views/list-view.ts`) — ✅ xong

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| ⬆ | `upload` | nav, nút Upload script | Tải script lên |
| ⟳ | `refresh-cw` | nav, nút Refresh | Làm mới danh sách |
| (không có) | `info` | nav, nút Help (§11.6 item 9) | Mở trang Help ở tab riêng — tái dùng icon đã có ở `item-form-view.ts` thay vì tải thêm icon "circle-question" mới |
| ⚙ | `settings` | `module-gear` | Mở Management View (Collection schema) |
| 👁 / 🙈 | `eye` / `eye-off` | `ui-valve` | Hiện/ẩn UI của module (§11.4) |
| ✏️ | `pencil` | lifecycle, nút Rename | Đổi tên script (§12.1) |
| ⬇️ | `download` | lifecycle, nút Download | Tải source script về (§12.1) |
| 🗑️ | `trash` | lifecycle, nút Delete | Xoá script (§12.1) |

## Popup (`ui/popup/views/action-result-view.ts`) — ✅ xong

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| ← | `arrow-left` | nút "Back" | Quay lại danh sách (giữ text "Back" cạnh icon) |

## Dashboard (`ui/dashboard/views/management-view.ts`) — ✅ xong

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| ✎ | `square-pen` | nút Edit mỗi row | Sửa item |
| ✕ | `x` | nút Delete mỗi row | Xoá item |

## Dashboard (`ui/dashboard/views/item-form-view.ts`) — ✅ xong

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| ⓘ | `info` | hover hint cạnh field có `field.hint` | Giải thích thêm |

## Studio (`ui/studio/main.ts`) — ✅ xong

Không phải thay emoji (Studio chưa từng dùng emoji) — 2 icon mới thêm cùng đợt sidebar bước (docs/ROADMAP.md §12.3). `.syn-icon-img` tự viết riêng trong `studio.css` (invert không điều kiện, khác popup/dashboard/side-panel: Studio luôn dark, không theo `prefers-color-scheme`).

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| (text "Save") | `save` | `#save-btn` | Lưu script — icon-only, `title`/`aria-label="Save"` (đổi từ icon+text ban đầu theo phản hồi user) |
| (không có) | `panel-right-open` / `panel-right-close` | `#toggle-steps-btn` | Đóng/mở sidebar bước — icon phản ánh trạng thái HIỆN TẠI (mở/đóng), cùng quy ước `eye`/`eye-off` ở popup, không phải hành động sẽ xảy ra |

## Side Panel (`ui/side-panel/main.ts`) — ✅ xong

| Trước | Lucide dùng | Ở đâu | Ý nghĩa |
|---|---|---|---|
| 📄 | `file-text` | section header "Reader Mode" | |
| 🎬 | `clapperboard` | section header "Media Sniffer" | |
| ⚙ | `settings` | nút "Media Sniffer settings" | Mở Dashboard |
| ▶ / ⏸ | `play` / `pause` | nút Resume/Pause download | |
| ⏹ | `square` | nút Stop (live capture) | |
| ✕ | `x` | nút Cancel | |
| ⚡ | `zap` | prefix "Turbo downloads" | Trang trí, không phải nút bấm |

`download.png` (đã dùng từ trước) giờ nạp qua registry chung thay vì import riêng.

## On-page floating icon/badge (content scripts, world ISOLATED) — quyết định: giữ nguyên emoji

`utils/ui-compositor.ts`'s `IconOptions.label`/`BadgeOptions.label` là `string`, render bằng
`el.textContent` — cố ý chỉ nhận "Glyph or emoji" theo đúng doc comment gốc. Đây là API **công khai**
đứng sau `synapseApi.ui.icon`/`ui.badge` mà **user script tự upload cũng gọi được**
(`rpc-client.ts`'s `buildDomModuleApi`, và bản tương đương trong `user-script-shim.ts` cho USER_SCRIPT
world) — không phải nội bộ builtin-only.

| Emoji | File | Ý nghĩa | Lucide gợi ý |
|---|---|---|---|
| ⬇ | `content-scripts/index.ts` (`showNetworkSnifferIcon`) | Icon nổi mở Side Panel khi phát hiện media | `download` |
| ⬇ | `features/media/dom-media-observer.content.ts` | Badge neo vào `<video>`/`<audio>` đã phát hiện | `download` |
| 📄 | `content-scripts/index.ts` (reader-mode icon `convert`) | Convert trang → Markdown | `file-text` |
| 🕸️ | `content-scripts/index.ts` (reader-mode icon `crawl`) | Crawl & convert cả site | không có "spider" — đã tải cả `globe` và `waypoints` để chọn |

**Vì sao chưa đổi**: thêm ảnh vào đây nghĩa là mở rộng `IconOptions`/`BadgeOptions` (thêm field kiểu
`iconUrl?: string`), và field đó **cùng lúc thành khả dụng cho mọi script upload gọi `ctx.api.ui.icon`**
— khác hẳn popup/dashboard/side-panel (chỉ code của extension chạy ở đó). Cần chọn giữa:
1. Field mới chỉ dùng nội bộ (builtin tự truyền `chrome.runtime.getURL(...)` tới asset của chính nó) —
   nhưng `IconOptions` không phân biệt được "ai gọi", nên không chặn được user script làm y hệt trừ khi
   thêm logic riêng.
2. Cho phép user script tự truyền `iconUrl` bất kỳ — mở khả năng nạp ảnh từ domain ngoài (tracking
   pixel, icon giả mạo UI trình duyệt) — cần nghĩ kỹ trước khi mở, đúng tinh thần thận trọng đã áp cho
   `page.eval`/`net.mock`.
3. Giữ nguyên `label` là glyph/emoji, không đổi gì — network-sniffer/reader-mode tiếp tục dùng emoji
   như builtin đã luôn làm.

**Đã chọn hướng 3 — giữ nguyên emoji, không đụng `ui-compositor.ts`.** Lý do: an toàn nhất, không mở
rộng bề mặt `synapseApi.ui.*` chỉ để đổi 4 icon nội bộ; `IconOptions`/`BadgeOptions.label` vẫn đúng
như doc comment gốc ("Glyph or emoji"). Nếu sau này cần đổi, quay lại 2 hướng còn lại ở trên.
