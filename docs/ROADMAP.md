# Roadmap

**Chỉ nhìn về hiện tại và tương lai.** File này giữ đúng 3 phần: đang làm gì, sắp làm gì, và điểm nghẽn. Mọi thứ đã ship nằm ở [CHANGELOG.md](CHANGELOG.md) — nếu bạn đang định viết "§X đã implement, đây là những gì nó làm" vào đây thì viết nhầm file.

| Cần gì | Đọc file nào |
|---|---|
| Cái gì đã tồn tại, ở đâu, đã sập kiểu gì | [CHANGELOG.md](CHANGELOG.md) |
| Kiến trúc + mọi quyết định đã chốt | [design.md](design.md) |
| Gotcha kỹ thuật (MV3 quirk, race, why-naive-fails) | [LESSONS.md](LESSONS.md) |
| Mục nào chưa được user xác nhận bằng Chrome thật | [TEST_PLAN.md](TEST_PLAN.md) |
| Danh sách API + catalog scope | [api-inventory.md](api-inventory.md) |

---

## Trạng thái hiện tại (2026-08-06)

Synapse là **một bản nâng cấp của Tampermonkey**: user script là công dân hạng nhất. Nền tảng (Kernel, permission model, Studio, download engine, 3 feature builtin) đã ship — xem [CHANGELOG.md](CHANGELOG.md).

**Định vị đã đổi, và nó định hình toàn bộ phần còn lại của roadmap:**

> **Builtin không phải một tầng sản phẩm. Nó là công cụ phát triển.**
> Một builtin được viết để *xác định logic*, rồi trích xuất thành API, rồi tái tạo bằng template script — sau đó **bị xoá**. Builtin không bao giờ nằm trong bản release; nó chỉ tồn tại trong bản dev.
> Tiêu chí nghiệm thu của một builtin vì thế là: **nó xoá được mà không mất năng lực nào.**

Một playground cung cấp builtin như một lớp đặc quyền vĩnh viễn là tự phân mảnh: hai hạng công dân, hai bộ năng lực, và cái hay nhất thì user không chạm được. Track B bên dưới tồn tại để đóng khoảng cách đó.

| Track | Nội dung | Trạng thái |
|---|---|---|
| **A** | State Lifetime — permanent / tab / navigation | 📋 Sẵn sàng, không phụ thuộc gì |
| **B** | Nghỉ hưu builtin (đường găng) — dev-only gate → uiSchema thống nhất → API parity → xoá | 📋 Chương trình chính |
| **C** | Pipeline flow control — state machine tuyến tính | 📋 Sẵn sàng |
| **D** | Power-user control surface (§13) | 📋 Sẵn sàng, độc lập |

---

## Đang làm (WIP)

**Không có mục nào đang dở.**

Nợ tồn đọng cần nhớ: [TEST_PLAN.md](TEST_PLAN.md) có ~20 mục đã implement nhưng chưa xác nhận bằng Chrome thật, trong đó §12.5 (Dry Run) **chưa chạy thật lần nào**. Tiền lệ rất rõ ([CHANGELOG.md](CHANGELOG.md)): mỗi lượt verify thật đến nay đều lôi ra 1–5 bug mà không test tự động nào bắt được.

---

# Track A — State Lifetime

**Vấn đề đang thấy được hằng ngày:** reload một trang, danh sách media của Media Sniffer **không xoá mà cứ dồn thêm**, trong khi link cũ đã hết hạn (signed URL). Side Panel thì reset state mỗi lần chuyển tab.

Gốc chung: **state hiện không có khái niệm vòng đời.** Mọi thứ đổ vào `chrome.storage.local` (vĩnh viễn) rồi lọc lại lúc đọc.

### A1. Ba lifetime, thành khái niệm hạng nhất của Kernel

| Lifetime | Chết khi | Ví dụ thật |
|---|---|---|
| **permanent** | không bao giờ (tới khi user xoá) | download job/checkpoint, grant, secret, mock rule |
| **tab** | tab đóng | Side Panel đang xem tab nào, turbo toggle |
| **navigation** | mỗi lần commit navigation, **kể cả reload cùng URL** | danh sách media đã phát hiện |

- Media list chuyển sang **navigation** — đây là bản vá thật cho bug "dồn link cũ". Khoá theo `tabId` + navigation commit, không phải theo `tabUrl` (reload cùng URL không đổi `tabUrl`, đó chính là lý do bug tồn tại).
- Side Panel state chuyển sang **tab** — vá `[§6.4]`.
- **Xong khi**: reload trang → list media chỉ còn link của lượt load hiện tại; chuyển tab đi rồi quay lại → Side Panel giữ đúng state của tab đó; download job vẫn sống qua cả hai.
- **Phụ thuộc**: không.

### A2. `synapseApi.storage` phản ánh đúng 3 lifetime

Platform có 3 lifetime mà script chỉ có 1 thì script lại thành công dân hạng hai — đúng thứ Track B tồn tại để xoá.

- Thêm `storage.session` / `storage.tab` cạnh `storage.local` hiện có, **cùng namespace `script:<moduleId>:` và cùng scope `storage.rw`** — đây là chiều *vòng đời*, không phải chiều *quyền*, nên không sinh scope mới.
- **Xong khi**: một script lưu state theo tab, chuyển tab rồi quay lại vẫn đọc đúng; state `session` biến mất sau navigation mà không cần script tự dọn.
- **Phụ thuộc**: A1.

### A3. TTL / GC cho state permanent

Gộp vào đây vì cùng là bài toán vòng đời — trước đây là Open Point riêng.

- Sweep định kỳ qua `chrome.alarms` (service worker không sống đủ lâu để `setTimeout` dài hạn). TTL mặc định đề xuất **7 ngày**.
- Áp cho: Review session (IndexedDB blob), và `DownloadJobCheckpoint` **mồ côi** — checkpoint mà `DetectedMedia` gốc đã bị evict hiện không còn bề mặt UI nào để resume HAY dọn, nên sống mãi.
- **Ship được phần backend trước với TTL hardcode.** Phần UI chỉnh TTL bị chặn bởi "chưa có trang Settings toàn cục" — xem D5.
- **Phụ thuộc**: không (nhưng làm sau A1 thì gọn hơn).

---

# Track B — Nghỉ hưu builtin (đường găng)

Chương trình chính, và là lý do tồn tại của phần lớn API còn thiếu. Vòng đời chuẩn của một builtin từ nay:

```
builtin (spike, chỉ dev)  →  trích xuất API  →  template script tái tạo  →  XOÁ builtin
```

### B0. Gate dev-only ở build time

- Builtin bị loại khỏi bundle release bằng **`import.meta.env.DEV`**, không phải bằng cờ runtime — cờ runtime vẫn để code đặc quyền nằm trong bundle của người dùng.
- **Rủi ro phải chấp nhận và ghi rõ**: code chỉ chạy ở bản dev sẽ mục ruỗng vì không ai chạy nó ở release. Chấp nhận được với vai trò spike, nhưng đừng giả vờ nó vẫn là tính năng được bảo trì.
- **Xong khi**: `npm run build` cho ra bundle không chứa 3 builtin; bản dev vẫn đủ để làm spike.
- **Phụ thuộc**: không. **Làm sớm** — nó chốt định vị trước khi ai kịp thêm builtin thứ tư.

### B1. `uiSchema` thống nhất cho MỌI bề mặt ← đây là phần lớn công việc

**Mục tiêu: một schema khai báo UI, dùng cho mọi nơi UI có thể xuất hiện.** Hôm nay `uiSchema` chỉ mô tả form/table trên trang extension, và chỉ Module bundled mới được cấp; script upload không có đường nào render lên trang đặc quyền.

- `uiSchema` thêm property **`container`** (tên tạm) khai *nơi* render: `'in-page' | 'side-panel' | 'tab' | 'popup'`. Schema khai **cái gì**, `container` khai **ở đâu**, renderer per-container lo **thế nào**.
- **Script upload được cấp `uiSchema` + `listCollection()`** — hạ tầng generic renderer + bus wiring đã chạy sẵn cho Module bundled, không phải viết mới.
- **Ràng buộc bảo mật là phần khó thật, không phải renderer**: schema do script khai được render trên **trang đặc quyền**, nên schema phải là dữ liệu thuần, tuyệt đối không HTML/handler tuỳ ý. Cùng lý do `page.eval` phải là scope riêng.
- Phase 6 cũ (declarative in-page UI engine) **bị hấp thụ vào đây**: nó trở thành *renderer của `container: 'in-page'`*, không còn là hệ thống riêng.
- **Xong khi**: một script upload khai `uiSchema` và có bảng CRUD trên Dashboard y hệt `http-error-mocker` hôm nay, không viết một dòng render nào; cùng schema đó đổi `container` sang `'side-panel'` thì hiện ở Side Panel.
- **Phụ thuộc**: không cứng, nhưng B3 chặn sau nó.

### B2. API parity — từng builtin một

Khoảng cách đo được hôm nay:

| Builtin | Script với tới | Còn thiếu |
|---|---|---|
| `http-error-mocker` | `fake-response` × `main-world` — **1 trong 6** tổ hợp | `block`, `rewrite-request`; mechanism `debugger`, `dnr` |
| `network-sniffer` | `media.list/inspect/download/job/control` | **`net.observe` dạng subscription** (2/3 nguồn phát hiện); toggle turbo |
| `iframe-unsandbox` | — | strip CSP header qua DNR |
| `reader-mode-converter` | gần đủ (đã chứng minh bằng [test-lib-reader-mode.js](examples/test-lib-reader-mode.js)) | chỉ crawl-site, **cố ý bỏ** (policy nghiệp vụ) |

**Quy tắc mở rộng `net.mock`, đã chốt:** script khai **ý định** (`block`/`rewrite`/`fake`), **platform vẫn chọn mechanism** — đúng nguyên tắc "phân quyền theo mục đích, không theo cơ chế" ([design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract)). Chi phí thật là platform phải tự giải ma trận ràng buộc (chọn mechanism rẻ nhất còn hỗ trợ được action đang xin), **không** phải thêm một field `mechanism` cho script.

**Ngoại lệ đã chốt cho `debugger`:** vẫn expose, nhưng sau **một grant riêng, đặc trưng**. Lý do chấp nhận được: Chrome đã tự có cơ chế cảnh báo (banner "đang debug tab" hiện liên tục, user không thể không thấy), và đối tượng người dùng của Synapse hẹp + kỹ thuật. Consent line phải nói thẳng về cái banner đó.

**`iframe-unsandbox` là API nguy hiểm nhất trong danh sách** — nó gỡ CSP của trang. Quyết định *expose hay khai tử* phải làm tường minh, không để trôi.

**Nguyên tắc nghiệm thu:** nghỉ hưu builtin **≠** mọi năng lực builtin đều thành API. Năng lực nào quyết định **không** expose thì ghi vào note của builtin đó như một mất mát có chủ đích — không im lặng bỏ.

- **Xong khi**: mỗi builtin có một dòng trạng thái parity trung thực; mọi năng lực hoặc đã có API, hoặc đã ghi rõ là bị khai tử.
- **Phụ thuộc**: **catalog scope phải chốt trước** (xem Open Points) — `debugger` grant là scope thứ 11, mà trần tự đặt là ~10.

### B3. Template đạt parity → xoá builtin

- Mỗi template script phải tái tạo được builtin tương ứng bằng API công khai, không một lời gọi đặc quyền nào.
- Xoá builtin, xử lý migration `activation[id]` cho người đã cài bản dev.
- **Xong khi**: 3 builtin biến mất khỏi `src/`, và 3 template làm được đúng việc chúng từng làm.
- **Phụ thuộc**: B1 + B2.

---

# Track C — Pipeline flow control (state machine, KHÔNG phải DAG)

**Nhu cầu thật, data-driven:** bước 1 tải nội dung trang; nội dung trả về có thể bị chặn bởi **Captcha** hoặc **Paywall**; bước 2 phải chọn strategy tương ứng ("Giải Captcha" vs "Inject Cookie"). Viết `if` bên trong một step **chạy được**, nhưng lúc đó strategy trở nên vô hình: sidebar không hiện được nhánh nào đã chạy, không bypass riêng được, không tái dùng được.

Cái thiếu vì thế **không phải sức biểu đạt mà là observability + composability**.

### C1. `when` / `next` / `repeat` — tất cả optional, không khai thì chạy tuần tự như cũ

| Property | Ngữ nghĩa | Ràng buộc |
|---|---|---|
| `when?` | bỏ qua step có điều kiện | giữ nguyên tuyến tính |
| `next?` | chọn step kế theo kết quả (strategy) | **CHỈ ĐƯỢC NHẢY TIẾN** |
| `repeat?` | lặp một step | đường **duy nhất** để lặp |

**`next` khoá cứng forward-only là quyết định thiết kế, không phải giới hạn tạm thời.** Đổi lại được hai thứ: mảng `steps` vẫn là thứ tự thật nên sidebar vẫn dự đoán được, và vòng lặp trở thành **một node gom nhóm được** — render một progress bar nhỏ *bên trong* step đó, thay vì đẻ ra N dòng lặp lại trong danh sách. Cho `next` nhảy lùi là mất cả hai tính chất đó và mở cửa cho vòng lặp không chặn.

- **Bất biến phải giữ**: mọi step vẫn chạy **cùng một execution context**. `reader-mode-converter` truyền một `Document` sống qua cả 4 bước — thứ đó không qua được ranh giới structured-clone. Bất kỳ đề xuất nào cho step sống ở context khác nhau phải trả lời câu đó trước.
- **Đây là lý do KHÔNG làm DAG**: node ở context khác nhau biến mọi cạnh thành ranh giới clone, và mất luôn khả năng visualize theo mảng.
- **Xong khi**: viết được pipeline Captcha/Paywall ở trên; sidebar Studio hiện đúng nhánh nào đã chạy và step nào bị skip; một `repeat` hiện thành một dòng có progress, không phải N dòng.
- **Phụ thuộc**: không.

---

# Track D — Power-user control surface (§13)

4 quyết định UI cùng chủ đề, không đụng Registry/Studio core.

### D1. Global Kill Switch

Key `synapse:global-enabled` (default `true`). **Enforcement ở gốc**: Scheduler check TRƯỚC mọi lời gọi module; content-script wiring (webRequest listener, DOM observer, floating icon) đọc cờ TRƯỚC khi đăng ký — chặn ở tầng `run()` thì listener vẫn "nghe" âm thầm, vẫn rò tài nguyên và đôi khi vẫn còn side-effect mạng. UI: banner "Synapse is disabled", không chỉ ẩn list — user cần NHỚ mình đã tắt.
- **Xong khi**: tắt → mọi module ngừng thật kể cả listener nền; bật lại → phục hồi đúng trạng thái từng module (không reset `synapse:activation`).

### D2. Tab-Aware List — lọc popup theo domain

Bundled/builtin: không lọc. Script upload: lọc theo `match` đã khai trên grant (tái dùng, **không** thêm field `displayMatches?` để hai field cùng nghĩa lệch nhau). **Chỉ là filter hiển thị, không phải enforcement.** Toggle "Show all" không persist.

### D3. Global Tasks trong Side Panel — inner-tab "This tab" / "All tabs"

"All tabs" liệt kê mọi job + checkpoint đang chờ resume. "Go to Tab" cần field mới `tabId?` (+ `tabUrl` fallback khi tab đã đóng) — job/checkpoint hiện **không** lưu.
- **Phụ thuộc**: thêm `tabId`/`tabUrl` vào checkpoint là **điều kiện chặn**. Gọn hơn nếu làm sau A1 (cùng đụng state theo tab).

### D4. Domain whitelist + blacklist cho in-page widget

Per-module, không global (lý do ẩn icon module A khác lý do ẩn module B).

- **Thứ tự đã chốt: whitelist lọc trước, blacklist trừ đi sau.**
- **Ngữ nghĩa tập rỗng đã chốt: whitelist rỗng = CHO TẤT CẢ.** (Khác `@match` của Tampermonkey, nơi rỗng = không chạy ở đâu cả — ở đây là filter *hiển thị*, nên rỗng phải là allow-all, nếu không mọi widget biến mất mặc định và tính năng vô dụng.)
- Enforcement: content-script check TRƯỚC khi gọi `showFloatingIcon`/`showAnchoredBadge` — khớp thì bỏ qua hoàn toàn, **không** tạo Shadow DOM host rồi ẩn bằng CSS.
- Trigger: right-click trên chính icon/badge → "Hide on this domain". Quản lý danh sách ở Dashboard's per-module view.

### D5. Trang Settings toàn cục

Hiện **không có** — Dashboard scoped per-`moduleId`. Đang chặn phần UI của A3 (TTL) và là nhà tự nhiên cho D1. Quyết định nơi đặt là việc phải làm, không phải chi tiết.

---

## Khu vực Open Points

Chỉ còn những thứ **thật sự chưa quyết được** hoặc **không hành động được**. Mọi mục đã chuyển thành phase nằm ở các Track phía trên.

### Chặn Track khác — cần quyết sớm

- **[Catalog scope] ~13 mục đề xuất vs trần tự đặt ~10 ([api-inventory.md §5](api-inventory.md)) — chưa chốt, và nay đã CHẶN B2.** Grant riêng cho `debugger` (đã chốt là sẽ có) là scope thứ 11. Hướng gộp đã chọn: **giảm chiều số lượng bằng chiều tài nguyên** (`×match` giới hạn thiệt hại tốt hơn chẻ nhỏ scope). Hai quyết định gộp còn tranh cãi: `media.read`+`media.download` gộp làm một; `tabs.open` bỏ hẳn khỏi v1.
- **[`iframe-unsandbox`] Expose hay khai tử — chưa quyết.** Nó gỡ CSP của trang, là API nguy hiểm nhất trong danh sách B2. Không để trôi: quyết tường minh, và nếu khai tử thì ghi vào note như mất mát có chủ đích.

### Cần debug trên trang thật — không vá thêm bằng giả thuyết

- **[§7.3-open] Anchor badge MSE/HLS vẫn không ổn định sau 3 vòng vá dựa trên đọc code** ([CHANGELOG.md](CHANGELOG.md#73a-hls-bug-thật--3-vòng-vá-vấn-đề-vẫn-còn)). Detection + download vẫn đúng (đi qua webRequest, độc lập); chỉ badge neo vào `<video>` là sai. **Việc tiếp theo BẮT BUỘC là instrument + debug một lượt trên trang thật**, không phải bản vá thứ 4. Escape hatch cho user đã có: `pipeline.hook('media.correlate-url', …)`.
- **[Badge anchoring] Badge vẽ lệch vị trí trên bilibili.tv, đúng vị trí trên trang khác.** Khác nguyên nhân với 3 bug trên (đó là sai *tín hiệu tương quan*; đây là tìm đúng URL rồi nhưng *neo toạ độ* sai). Nghi CSS trang (`transform`/`zoom` trên `<html>`/`<body>`) phá giả định `position:fixed` của `ui-compositor.ts`. **Có thể tái hiện được bằng Playwright + CDP trên một trang tự dựng có CSS đó** — đây là ứng viên đóng được mà không cần user.
- **[§10.2] Ad-filter cho stream trực tiếp** — cần ca thật để hoàn thiện logic bắt link trước. Đã biết: 3 nguồn phát hiện bất đồng về `initiator` (không phải bug).

### Nợ kỹ thuật đã chấp nhận — không định sửa

- **[§11.2] Phần I/O của download engine không có test, CỐ Ý.** `features/media/download/*.offscreen.ts` không test được ở `environment: 'node'` và không đáng dựng harness. **Hệ quả phải nhớ: mọi thay đổi trong 3 job kind sẽ KHÔNG bị `npm test` chặn lại.**
- **[§11.3] Đường dispatch `run(input)` trong shim trailer nghi là chết** — nghe `chrome.runtime.onMessage` trong USER_SCRIPT world, nhưng Chrome định tuyến chiều đó sang `onUserScriptMessage`. Không ai gọi tới nên chưa gây hại. Cố ý không xoá vội; **nếu thêm caller thì phải verify end-to-end trên Chrome thật TRƯỚC.**
- **[§10.3] Media MSE không lộ manifest** — hai bản vá nhỏ chưa làm: (i) chỉ đánh dấu `probedMagicByteOrigins` khi probe thật sự vô ích / cap theo số lần; (ii) thêm `styp`/`moof` vào magic-bytes (hôm nay chỉ có `ftyp`, tức chỉ nhận init segment). **Cả hai đều là hàm thuần, test được, rẻ.**
- **[§7.3(b)] Hook `SourceBuffer.appendBuffer`** — đường tổng quát né cả lớp correlation-đoán-mò, nay đã có ca thật cần nó (§10.3). Nên debug §7.3-open trước.
- **[§8] Offscreen Document idle timeout** — đã chốt hướng (tự đóng sau ~60s không còn job), chưa implement. **Điều kiện bắt buộc**: không job nào ngoài `done`/`error`/`cancelled` — đóng giữa `paused` mất `JobControl` trong RAM (turbo và live không có checkpoint, mất trắng).
- **[Kiến trúc UI] Pub/Sub State Manager tập trung — vẫn KHÔNG phải quyết định làm.** Mỗi view tự fetch, không có store broadcast khi state đổi nơi khác. **Chưa có case đau cụ thể** — cần bằng chứng desync nhìn thấy được trong sử dụng thật trước khi cân nhắc. Lưu ý Track A có thể làm nhu cầu này rõ hơn hoặc biến mất.
- **[§11.4] Thứ tự icon theo `ownerId` (uuid) — ổn định nhưng vô nghĩa với user.** Muốn sắp theo tên thì label phải nướng vào shim lúc register (USER_SCRIPT world không có `chrome.storage`), **nghĩa là đổi tên script sẽ không đổi thứ tự cho tới lần register kế** — trừ khi rename kéo theo re-register. Đó là một quyết định, không phải một dòng code.

### Rủi ro mở

- **[BẢO MẬT — ĐÃ VÁ] `cache` từng là đường leo thang đặc quyền.** Vá bằng **hai** thay đổi độc lập, **giữ cả hai khi sửa tiếp**: namespace `script:<moduleId>:` lấy từ transport, và `rpc-handler` không route service key-value trần nào. Chi tiết: [design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract).
- **[§8.11]** Bản vá relay 3 kênh (query-replay-headers / sync-header-replay-rule / describe-header-replay / trigger-download) **chưa re-verify bằng browser thật** — cần xác nhận không bị listener khác giành response, và header replay thật sự chạy trên site hotlink-protect.
