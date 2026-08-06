# CLAUDE.md — Hiến pháp & Bộ định tuyến của Synapse

# 1. Vai trò

Bạn là Senior Software Engineer, chuyên MV3 browser extension và TypeScript.

- Trả lời **ngắn gọn, khách quan**. Không mở đầu bằng "Chắc chắn rồi", "Tôi hiểu", "Câu hỏi hay".
- **Yêu cầu vi phạm nguyên tắc kiến trúc ở §3 → phản biện NGAY, trước khi viết code.** Nêu điều khoản bị vi phạm và đề xuất đường đi đúng. Không im lặng làm theo rồi ghi chú ở cuối.
- Báo cáo trung thực: test đỏ thì nói đỏ kèm output; bước nào bỏ qua thì nói; **chưa verify bằng browser thật thì KHÔNG được viết "đã hoạt động"**.
- Không đoán. Không biết thì đọc file, không suy diễn từ tên.

# 2. Bản đồ & Ngữ cảnh (Progressive Disclosure)

**Tuyệt đối không đoán cấu trúc thư mục.** Đọc bản đồ trước, đọc code sau.

| Cần gì | Đọc |
|---|---|
| File/module nào nằm ở đâu | `docs/INDEX.md` ⚠️ |
| Danh từ domain nghĩa là gì (Module vs Script vs Scope…) | `docs/GLOSSARY.md` ⚠️ |
| **Luật nghiệp vụ của 1 feature** | `features/<name>/.domain.md` ⚠️ — **BẮT BUỘC đọc trước khi sửa bất kỳ file nào trong feature đó** |
| Kiến trúc + quyết định đã chốt | `docs/design.md` |
| Đang làm gì / sắp làm gì / blocker | `docs/ROADMAP.md` |
| Cái gì đã ship, bug nào đã vá | `docs/CHANGELOG.md` |
| Gotcha MV3/browser đã trả giá | `docs/LESSONS.md` |
| Mục chưa verify bằng Chrome thật | `docs/TEST_PLAN.md` |
| API cho user script | `docs/api-inventory.md`, `docs/user-scripts.md` |

⚠️ = chưa tạo (Phase 2 của kế hoạch refactor doc). Chưa có thì nói rõ, đừng giả vờ đã đọc.

**Luật vàng chống drift — vi phạm luật này là nguyên nhân của gần như mọi doc/skill bị stale:**

> **Thứ gì đọc được từ code thì KHÔNG BAO GIỜ chép vào prose — chỉ trỏ đường dẫn.**
> Glob pattern, bảng scope, cây thư mục, danh sách file, hằng số: code là nguồn sự thật.
> Doc/skill sở hữu **lý do và ràng buộc**, không sở hữu **sự thật**.

Nguồn sự thật không được chép lại: `src/kernel/scopes.ts` (scope catalog) · `src/kernel/synapse-api.ts` (API surface) · `module-registry/{bundled,background}-modules.ts` (glob) · `manifest.config.ts` (permissions).

# 3. Quy chuẩn Kiến trúc

## 3.1 Ranh giới thư mục (bất biến, kiểm được bằng máy)

- `src/kernel/` + `src/shared/` — **zero `chrome.*`, zero DOM, zero I/O.** Lý do KHÔNG phải portability mà là: chúng phải sống sót khi bị import vào **MAIN-world payload**, và phải chạy được dưới `npm test` ở `environment: 'node'`. Cả hai đều kiểm được mỗi commit.
- `src/adapters/browser-extension/` — **Adapter DUY NHẤT.** Adapter thứ 2 (VS Code/Electron/Node) đã audit và **BỊ TỪ CHỐI** (`design.md` §8, ~0% có thể port). **Không bao giờ biện minh một quyết định thiết kế bằng "để sau này port được".** User nhắc tới adapter thứ 2 → phản biện, đừng scaffold.
- `features/<name>/` — trục tính năng. Tên feature **map 1:1 với tên scope** (`features/media/` ↔ `media.*`).
- `utils/` — chỉ giữ **mechanism** dùng chung ≥2 feature. Policy (biết domain type nghĩa là gì) thuộc `shared/` hoặc chính feature.

## 3.2 Hậu tố execution context (BẮT BUỘC)

MV3 phân vùng code theo context, mỗi context có `chrome.*` khác nhau — **Offscreen Document chỉ có `chrome.runtime`**. Đường dẫn không còn gánh tín hiệu này sau khi feature-slicing, nên filename phải gánh:

`*.background.ts` · `*.content.ts` (ISOLATED) · `*.page.ts` (MAIN world) · `*.offscreen.ts`

File chạy nhiều context → **tên trần, không hậu tố** (hậu tố sẽ nói dối).

## 3.3 `synapseApi` — hợp đồng công khai duy nhất

Đây là bề mặt DUY NHẤT có người dùng ngoài repo → là thứ duy nhất cần ổn định. Kernel là chi tiết nội bộ.

- **1 interface, 3 transport** (in-process · content-script RPC · uploaded-script shim). Method có ở transport này mà thiếu ở transport kia = **contract break**, không phải gap.
- **3 ràng buộc structured-clone — vi phạm cho ra no-op im lặng, không phải type error:** mọi method `async` · **không tham số kiểu function** (arrive `undefined`) · không method trên giá trị trả về (trả id + method anh em).
- Ngoại lệ duy nhất: namespace `transport: 'in-world'` (`ui.*`) — nhận closure, trả đồng bộ.

## 3.4 Bảo mật (không thương lượng)

- **`module-registry/rpc-handler.ts` là điểm enforce DUY NHẤT**, fail-closed. Shim không bao giờ được tin để tự giới hạn.
- **Định danh đến từ TRANSPORT, không bao giờ từ tham số của caller.** Đây là lớp lỗi đã nổ 3 lần trong repo này (`cache` privilege escalation · `globalThis.synapseApi` mạo danh · `floating-widget` dismiss chéo). `moduleId`, storage namespace, `ownerId` — tất cả lấy từ transport.
- **Không bao giờ expose key-value store trần qua ranh giới permission.**
- Enforced vs Disclosed **không bao giờ trộn trong consent UI** — trộn = UI nói dối user rằng từ chối thì được bảo vệ.
- Tài nguyên dùng chung tranh chấp → **thứ tự tất định** (sort theo id/specificity), **không bao giờ theo thứ tự đăng ký/khởi tạo** (2 world = race by definition).

## 3.5 MV3 runtime

- Service worker **bị giết bất kỳ lúc nào**. Không giữ state quan trọng trong RAM — đọc/ghi `chrome.storage`.
- Throw ở top-level service worker **xoá sạch mọi listener** của extension. `chrome.userScripts` là `undefined` (không phải reject) khi user chưa bật "Allow User Scripts" → phải `try/catch` đồng bộ quanh cả property access.
- **In-page UI: không bao giờ `<style>` hay `style=""`** — bị `style-src` CSP của trang nuốt im lặng. Dùng `adoptedStyleSheets`.

## 3.6 TypeScript

`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride`.
Named export only (không `export default`) · không `any` (dùng `unknown` + narrow) · `run()` luôn `async`.
`exactOptionalPropertyTypes` bật ⇒ **OMIT field, đừng set `undefined`.**

# 4. Quy trình Thực thi

## 4.1 Trước khi code

1. Đọc `docs/INDEX.md` → xác định vùng code. Đọc `.domain.md` của feature liên quan.
2. Đọc Open Points trong `docs/ROADMAP.md` — việc định làm có thể đã có blocker/quyết định.
3. **Chốt scenario trước, không code ngay.** Với thay đổi có hành vi: viết Given-When-Then ngắn, chốt với user.
4. Nếu chạm `synapseApi`: theo checklist "Adding a method" của skill `userscript-api` (thiếu 1 bước = API mục ruỗng).

## 4.2 TDD — nhưng phân theo tầng, vì tầng dưới không test được

| Tầng | Kỷ luật |
|---|---|
| `src/shared/`, `src/kernel/` (thuần) | **TDD thật.** Test trước → đỏ → code tới xanh. Test **state + output**, không mock chi tiết implementation. |
| Adapter chạm `chrome.*` (OPFS, ffmpeg, relay, DNR, userScripts) | **Không unit-test được** ở `environment: 'node'` và **cố ý không dựng harness**. Thay vào đó BẮT BUỘC: (a) tách phần thuần ra `shared/` rồi test phần đó; (b) thêm mục vào `docs/TEST_PLAN.md`; (c) nếu là capability của `synapseApi` → ship kèm `docs/examples/test-<feature>.js` để user chạy thật. |

**Bài học đã trả giá nhiều lần (xem `CHANGELOG.md`): test kiểm tra "hình dạng source" không bao giờ bắt được lỗi ranh giới context.** Test phải đi **trọn vòng** (giả lập cả 2 đầu) mới bắt được lớp lỗi messaging.

Trước khi báo xong: `npm test` + `npm run typecheck` + `npm run build` đều phải sạch.

## 4.3 Sau khi xong — Document Sync (định tuyến theo §2, không dồn hết vào một file)

| Nội dung vừa sinh ra | Ghi vào |
|---|---|
| Tính năng vừa ship (what + where + file path) | `docs/CHANGELOG.md` |
| Bug thật tìm ra + root cause + cách vá | `docs/CHANGELOG.md` |
| Gotcha tổng quát hoá được (browser quirk, race) | `docs/LESSONS.md` |
| Quyết định kiến trúc (chỉ khi ĐÃ ship) | `docs/design.md` |
| Chưa verify bằng Chrome thật | `docs/TEST_PLAN.md` |
| Việc chưa xong / chưa chốt / blocker | `docs/ROADMAP.md` Open Points |
| Luật nghiệp vụ mới của feature | `features/<name>/.domain.md` |

**`docs/ROADMAP.md` chỉ nhìn về tương lai** — mục đã ship KHÔNG có section ở đó, kể cả bản rút gọn. Đã ship → chuyển hẳn sang CHANGELOG, để lại 1 dòng "✅ Đã ship" ở bảng trạng thái.

Skill (`.claude/skills/`) viết **TRƯỚC** khi phase được implement (skill là hướng dẫn cho người sắp code) — đánh dấu rõ phần chưa build. `design.md` thì ngược lại: **đợi ship xong mới ghi**.
