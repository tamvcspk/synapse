# Roadmap

Trạng thái các hạng mục đang xét, dùng làm state memory giữa các phiên làm việc. Không phải build spec — khi bắt tay implement một mục, đọc lại quyết định đã chốt bên dưới trước khi code.

## 1. Reader Mode Converter

**Trạng thái:** Đã implement, bao gồm trigger (phase 2). [module-trigger.ts](../src/adapters/browser-extension/popup/module-trigger.ts) gửi `{moduleId, input}` tới content-script của tab đang active qua `chrome.tabs.sendMessage`; [action-result-view.ts](../src/adapters/browser-extension/popup/views/action-result-view.ts) hiển thị `{title, markdown}` kèm nút Copy (in-flow view, không phải `<dialog>` — xem mục 2's ghi chú về việc bỏ native dialog khỏi popup này).

- `HtmlToMarkdownConverter` (duyệt DOM, không I/O) → Global SDK, [src/shared/html-to-markdown.ts](../src/shared/html-to-markdown.ts). Pure function `htmlToMarkdown(root, { baseUrl })`; tự resolve relative URL → absolute qua `new URL(value, baseUrl)`; lọc node ẩn qua `offsetWidth <= 0`.
- `ReaderDistiller` (heuristic mật độ chữ, chọn node nội dung chính) → policy, colocated trong Module thay vì `src/shared/` vì đây là quyết định riêng của module, không phải mechanism dùng chung.
- Module: [reader-mode-converter.module.ts](../src/adapters/browser-extension/content-scripts/modules/reader-mode-converter.module.ts), `needs: ['dom']`, auto-discovered qua `bundled-modules.ts` (không cần wiring thủ công). `run()` không nhận input, trả về `{ title, markdown }`.
- **Trigger đã implement:** `uiSchema: {kind: 'action', actionLabel: 'Convert to Markdown'}` trên Module — Gear/Arrow icon trên dòng module ở Main Registry View (mục 2) trigger trực tiếp `run()` (không navigate) vì schema là Action, không phải Collection — xem "hai hành vi của icon" ở mục 2.

## 2. Tách mock-config-section khỏi popup thành generic renderer

**Trạng thái:** Đã implement.

- Declarative UI Schema: [kernel/ui-schema.ts](../src/kernel/ui-schema.ts) — `UISchema = UICollectionSchema | UIActionSchema`, discriminate bằng `kind` (không phải boolean); `CollectionCommand<T>` là wire shape chung cho Bus write path. `Module.uiSchema` / `RegistryEntry.uiSchema` mang schema từ Module ra Registry.
- `chrome-module-registry.ts` giờ gộp cả `BUNDLED_MODULES` lẫn `BACKGROUND_MODULES` khi build entries — trước đây `http-error-mocker` (`needs: ['bus']`, sống ở `background/modules/`) không hề có `RegistryEntry`, nên Slide Toggle/Gear icon không thể áp dụng cho nó. `http-error-mocker/index.ts` giờ tự gate theo `isModuleActive` (trước đây toggle chỉ là cosmetic).
- Generic renderer thay `renderMockConfigSection`/`renderMockConfigRow`: [views/management-view.ts](../src/adapters/browser-extension/popup/views/management-view.ts) (data table + filter + Back, chỉ biết `UISchema`/`Record<string,unknown>`), [views/item-form-view.ts](../src/adapters/browser-extension/popup/views/item-form-view.ts) (form sinh từ `schema.fields`), [module-data-sources.ts](../src/adapters/browser-extension/popup/module-data-sources.ts) (chỗ duy nhất trong popup còn biết `MockConfig`, map moduleId → CRUD qua Bus).
- Chỉ làm phạm vi "Dedicated Management Page" (hình thái UI #1). Không làm Shadow DOM popover / action-button paradigm ở bước này (xem mục 4).
- **Fix theo dõi (sau khi dùng thật):** toàn bộ popup (item-form, action-result, capability-consent) đã chuyển từ native `<dialog>.showModal()` sang in-flow view swap qua [router.ts](../src/adapters/browser-extension/popup/router.ts)'s `View` union — `<dialog>` bị Chrome MV3 popup clip vì top layer không tham gia vào phép tính auto-size của popup window, nút Cancel/Close có thể render ngoài vùng nhìn thấy được. Xem rule tương ứng trong `module-registry` skill: **không dùng `<dialog>` trong popup này nữa.**

### Navigation Flow (đã chốt)

```
[MÀN HÌNH CHÍNH: LIST MODULES]
       │
       ├──► Module KHÔNG có Setting ──► Chỉ có Slide Toggle (Bật/Tắt trực tiếp)
       │
       └──► Module CÓ Setting ────────► Có Slide Toggle + Icon "Gear/Arrow"
                                               │
                                               ▼ (User click vào Module hoặc Icon)
                                 [MÀN HÌNH CẤU HÌNH CHI TIẾT]
                                 (Trang Management / Config riêng)
```

- **Main Registry View:** danh sách toàn bộ Module kèm trạng thái On/Off. Module có cấu hình → click target trên dòng đó điều hướng sang Management View. Không có trang settings riêng ngoài luồng này — giữ đúng "single list view by design" đã ghi ở §7 design.md, chỉ mở rộng thành view-swap thay vì trang tĩnh.
- **Module Management View:** thay thế hoàn toàn nội dung popup (View Swapping, không phải modal/dialog) khi module có schema phức tạp. UI (data table, filter, nút Back) được sinh tự động từ Declarative UI Schema của module đó — không viết tay renderer riêng cho từng module như `mock-config-section` hiện tại. Add/Edit item cũng là View Swapping (điều hướng sang `item-form`, lưu xong điều hướng lại `management`) — không bật popup/dialog nào, kể cả cho form nhập liệu.
- **Điều kiện hiện Gear/Arrow icon:** dựa trên việc `RegistryEntry` có mang UI schema hay không (cần thêm field, ví dụ `configSchema?: UISchema`, vào [module-registry.ts](../src/kernel/module-registry.ts)) — không phải dựa vào danh sách hardcode tên module như cách `main.ts` đang làm với `http-error-mocker`.
- **Hai hành vi của icon (đã chốt, cần phân biệt khi implement):** icon không chỉ có nghĩa "mở Management View". Nếu schema là dạng Collection/CRUD (ví dụ `http-error-mocker`) → điều hướng sang Management View như flow trên. Nếu module không có config để lưu mà chỉ cần một hành động on-demand (ví dụ `reader-mode-converter`, mục 1) → click icon **trigger thẳng `run()` của module** và hiển thị/xuất kết quả tại chỗ, không điều hướng trang. Registry cần phân biệt hai case này qua shape của schema (có Collection/Array hay không), không phải một field boolean đơn "hasConfig".

## 3. Module Chain (Composite Module) — chỉ bản tuần tự

**Trạng thái:** Đã chốt phạm vi, chưa implement.

Quyết định đã chốt:
- **Không có rollback.** Composite Module chỉ là pipeline: output của sub-module A là input của sub-module B qua tham số `run()`, giống `Scheduler.runPipeline` hiện tại ([scheduler.ts](../src/kernel/scheduler.ts)). Nếu A throw, báo lỗi nhánh đó và hệ thống trôi tiếp — không ép state nào lùi lại. Giữ nhất quán với triết lý "graceful fail" đã có.
- **Không có Context Share mutable.** Sub-module không đọc/ghi trực tiếp vào state dùng chung — tránh vi phạm Atomic Autonomy (§5 design.md). Nếu cần state dùng chung thật sự, dùng `bus`/`cache` capability sẵn có, không phải cơ chế mới.
- **Nâng cấp `RegistryEntry`** ([module-registry.ts](../src/kernel/module-registry.ts)) để hỗ trợ sub-toggle:
  ```typescript
  interface RegistryEntry {
    active: boolean;
    subState?: Record<string, boolean>; // trạng thái bypass của từng bước con
  }
  ```
  Đây là thay đổi Port hợp lệ, phục vụ trực tiếp UI sub-toggle của Composite Module.

Việc cần làm khi implement: Composite Module tự thỏa `interface Module` (có `id`, `run()`), nội bộ gọi tuần tự các sub-module theo `subModuleIds`, tôn trọng `subState` để bypass bước bị tắt.

## 4. Generic Network Sniffer / Shadow DOM popover / Action-button paradigm

**Trạng thái:** Hoãn — ghi nhận hướng đi, không scaffold cho tới khi có yêu cầu cụ thể (theo convention §8 design.md: roadmap, not build spec).

- **Generic Network Sniffer:** `webRequest`/`declarativeNetRequest` là permission nặng của Chrome, đòi hỏi khai báo minh bạch trong `manifest.config.ts` và có thể cả `host_permissions`. **Không được đánh đồng vào capability `net` hiện tại** — `net` hôm nay chỉ là cờ danh nghĩa (không map tới Service nào trong [service-injector.ts](../src/kernel/service-injector.ts)), gộp permission thật vào đó là sai lầm về mô hình cấp phép. Phải là một Adapter-utils độc lập mới, chỉ dựng khi có Module thật sự cần.
- **Shadow DOM popover trên trang (In-Page Float Widget):** content-scripts hiện không có UI engine nào; cần dựng injection helper mới trong `utils/`. Trigger on-demand (On-Demand Visibility) khi business logic của module phát hiện tín hiệu phù hợp, ví dụ `Generic Network Sniffer` báo "Tìm thấy 2 Video, click để tải" — chỉ nên xây khi mục trên (Network Sniffer) hoặc module tương tự thực sự được duyệt.
- **Action-button paradigm (Extension Bar Action Button):** rào cản kỹ thuật thật, không chỉ là khai báo schema — nếu `action.default_popup` còn khai báo tĩnh trong manifest, trình duyệt sẽ nuốt trọn sự kiện click để mở popup đó, `chrome.action.onClicked` sẽ **không bao giờ fire**. Muốn dùng icon extension làm Quick Action (ví dụ `Reader Mode Converter` bấm icon → chạy thẳng `run()` ở background), phải chuyển sang cơ chế quản lý popup động — `chrome.action.setPopup({ popup: '' })` tùy theo module nào đang active — trước khi module bất kỳ được phép khai báo paradigm này. Coi đây là một Future Adapter, không phải một lựa chọn ngang hàng với Dedicated Management Page trong Declarative UI Schema hiện tại.
  - Khi triển khai, icon hiển thị trên toolbar/`chrome.action` nên do chính Module khai báo (ví dụ thêm field icon vào `uiSchema`/manifest), không phải icon cứng hiện tại trên dòng Main Registry View — dòng list vẫn giữ gear/arrow + `title` tooltip như hôm nay cho tới lúc paradigm này thật sự được implement.

Khi một trong ba mục trên có business case cụ thể, bổ sung field khai báo paradigm vào manifest của Module (ví dụ `uiParadigm: 'none' | 'dedicated-page' | 'float-widget' | 'action-button'`) và mở rộng `RegistryEntry`/Registry renderer tương ứng — không thêm field này trước khi có implementation thật đứng sau nó.
