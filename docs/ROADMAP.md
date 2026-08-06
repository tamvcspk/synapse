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

Synapse là **một bản nâng cấp của Tampermonkey**: user script là công dân hạng nhất, 3 module builtin (`network-sniffer`, `http-error-mocker`, `reader-mode-converter`) tụt xuống vai trò reference implementation + nguồn cung cấp API, mặc định TẮT.

| Track | Trạng thái |
|---|---|
| Nền tảng builtin (§1–§10: reader-mode, sniffer, downloader engine, http-mock) | ✅ Đã ship |
| Pivot Userscript Platform Phase 0→5 (§11.1–§11.6) | ✅ Đã ship — **Track API đóng lại hoàn toàn** |
| Script Studio §12.1→12.5 (vòng đời, Monaco, steps, template, Dry Run) | ✅ Đã ship |
| Phase 6 (Declarative UI engine) | 📋 Kế hoạch — **cố ý chưa bắt đầu**, xem điều kiện dưới |
| Phase 7 (Container sandboxed iframe) | 📋 Kế hoạch — đắt, làm sau cùng |
| §13 Popup mở rộng / Side Panel đa-tab / Domain Blacklist | 📋 Kế hoạch — độc lập, bắt đầu được ngay |

---

## Đang làm (WIP)

**Không có mục nào đang dở.** Phase 5 và §12 vừa đóng cùng lúc; hai track đã lên kế hoạch từ trước đều hết mục.

Việc gần nhất đáng làm không phải viết thêm tính năng mà là **trả nợ verify**: [TEST_PLAN.md](TEST_PLAN.md) đang có ~20 mục đã implement nhưng chưa được xác nhận bằng Chrome thật, trong đó §12.5 (Dry Run) chưa chạy thật lần nào. Tiền lệ trong dự án này rất rõ (xem [CHANGELOG.md](CHANGELOG.md)): mỗi lượt verify thật đến nay đều lôi ra 1–5 bug mà không test tự động nào bắt được, và nhiều bug trong số đó có tuổi đời nhiều phase.

---

## Sắp làm (To-Do)

Ba mục dưới đây độc lập với nhau — làm cái nào trước cũng không chặn cái kia.

### §13. Popup mở rộng, Side Panel đa-tab, Domain Blacklist — rẻ nhất, bắt đầu được ngay

4 quyết định UI cùng chủ đề "power-user control surface", không đụng Registry/Studio core.

| Chủ đề | Chốt | Vì |
|---|---|---|
| Global Kill Switch | **Làm** — 1 toggle lớn ở Popup, tắt là tắt THẬT (Kernel-level gate) | Cách tắt nhanh toàn bộ extension không phải tắt từng module một |
| Tab-Aware List | **Làm** — Popup lọc module theo domain của tab đang active | Danh sách dài dần khi có nhiều script upload |
| Global Tasks (Side Panel) | **Làm dạng inner-tab switch** ("This tab"/"All tabs"), KHÔNG phải trang riêng | Giữ nguyên khung Side Panel đã có, chỉ thêm 1 cấp điều hướng con |
| Domain Blacklist | **Làm** — per-module, trigger từ chính floating icon/badge | Nhất quán với chỗ user đang nhìn thấy vấn đề |

**13.1 Global Kill Switch.** Key mới `synapse:global-enabled` (default `true`). Enforcement **ở gốc**: Scheduler check flag TRƯỚC mọi lời gọi module (không rải `if (!globalEnabled)` vào từng Module); content-script wiring (webRequest listener, DOM observer, floating icon) cũng phải đọc flag TRƯỚC khi đăng ký — nếu chỉ chặn ở tầng `run()`, listener vẫn "nghe" âm thầm, chỉ là không emit gì (rò rỉ tài nguyên + đôi khi vẫn còn side-effect như network request). UI: banner "Synapse is disabled", không chỉ ẩn list — user cần NHỚ mình đã tắt, không phải đoán vì sao danh sách trống.
- **Xong khi**: tắt → mọi module ngừng thật kể cả listener nền; bật lại → phục hồi đúng trạng thái từng module trước đó (không reset `synapse:activation`).
- **Phụ thuộc**: không.

**13.2 Tab-Aware List.** Bundled module KHÔNG lọc (universal theo thiết kế). Uploaded script lọc theo `match` đã khai trên grant (tái dùng, không thêm field `displayMatches?` để 2 field cùng ý nghĩa lệch pha); script không khai `match` nào coi là universal, luôn hiện. **Chỉ là filter hiển thị, không phải enforcement** — đừng nhầm với trục Enforced/Disclosed ở [design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract), đó là security boundary, đây là UX convenience. Toggle "Show all" không persist qua lần mở Popup kế tiếp.
- **Phụ thuộc**: không.

**13.3 Global Tasks trong Side Panel.** "This tab" giữ nguyên hành vi hiện có. "All tabs" liệt kê MỌI active job + `DownloadJobCheckpoint` đang chờ resume, không lọc theo tab (cần Offscreen relay trả danh sách toàn cục thay vì chỉ job của caller). "Go to Tab" cần field mới `tabId?` (+ `tabUrl` fallback nếu tab đã đóng) — job/checkpoint hiện KHÔNG lưu.
- **Phụ thuộc**: **§8 — thêm `tabId`/`tabUrl` vào `DownloadJobCheckpoint` là điều kiện CHẶN, không phải chi tiết phụ.**

**13.4 Domain Blacklist cho In-page Widgets.** Per-module, không global (lý do ẩn icon module A khác lý do ẩn icon module B; gộp chung sẽ ẩn nhầm). Trigger: right-click floating icon/badge → "Hide on this domain" → `synapse:widget-blacklist:<moduleId>`. Enforcement: content-script check blacklist TRƯỚC khi gọi `showFloatingIcon`/`showAnchoredBadge` — domain khớp thì bỏ qua hoàn toàn, KHÔNG tạo Shadow DOM host rồi ẩn bằng CSS. Quản lý danh sách ở Dashboard's per-module view (chỉ hiện khi `uiParadigm: 'float-widget'`).
- **Phụ thuộc**: không.

### Phase 6 — Declarative UI engine + component library

- Mở rộng `kernel/ui-schema.ts` sang layout in-page (**đừng đẻ DSL thứ 2**); engine chạy trong world của script; component library dùng chung một constructed sheet; positioning; storage-bound state qua `storage.rw`.
- Đây cũng là chỗ làm **shadow root lồng cho từng owner** — cố ý chưa làm ở Phase 3 vì lợi ích duy nhất của nó (giữ CSS script này khỏi script kia) chỉ có nghĩa khi script tự mang style, mà API imperative hiện tại thì không.
- **Xong khi**: một script khai báo được UI mà không gọi `document.createElement`.
- **Phụ thuộc**: Phase 3 (đã xong) phải có **consumer thật** trước. **KHÔNG bắt đầu nếu chưa có** — đây là phase đắt nhất (dễ gấp 3–5 lần `kernel/` hiện tại), và tiền lệ `ui.render` (dự đoán Enforced hoá ra là Disclosed) cho thấy phán đoán trước-khi-implement ở khu vực này hay sai.

### Phase 7 — Container sandboxed iframe (cơ chế B) — đắt, làm sau cùng

Mô hình container **hybrid**: UI nổi trên trang → Shadow DOM + compositor (cơ chế A, đã xong). Page riêng / Sidebar tab → mỗi script một sandboxed iframe. Lý do bắt buộc: script **không chạy được trong extension page** (MV3 CSP chặn `eval`/dynamic `import` ở context đặc quyền, và `chrome.userScripts` chỉ match URL trang web) — `manifest.sandbox.pages` là đường duy nhất Chrome chấp nhận, manifest hiện chỉ có `extension_pages`.

| | **A · UI nổi (Shadow DOM)** | **B · Page riêng / Sidebar tab (iframe sandbox)** |
|---|---|---|
| Cách ly | Shadow root — CSS tách, **event vẫn rò** | Document riêng — **CSS + event + JS tách hoàn toàn** |
| DOM của trang | ✅ trực tiếp | ❌ không có |
| `chrome.*` | RPC qua shim | postMessage lên parent → background (sandbox = origin `null`) |
| Storage riêng | qua RPC | **bắt buộc** postMessage (sandbox không có IndexedDB/localStorage) |
| Tranh chấp chỗ | cần compositor | tự hết — mỗi frame một không gian |

**Luật rút ra — container quyết định `page.dom` là Enforced hay Disclosed:** ở A script vốn có DOM nên `page.dom` chỉ khai báo được; ở B script KHÔNG có DOM trang, muốn chạm phải đi qua `page.*` API → **`page.dom` thành Enforced thật.** Đây là lý do chọn B cho script không thực sự cần bám vào trang, không phải tác dụng phụ.

Việc phải làm: **script hai nửa** (khai `container: 'float'|'panel'|'page'`; cần cả hai thì khai 2 entry point, platform nối bằng channel scoped theo `moduleId` — lại đúng luật "định danh do platform gán"); **sidebar tab không được nở vô hạn** (chỉ script thực sự yêu cầu panel trên trang hiện tại mới có tab, có overflow, **thứ tự tab vẫn phải tất định** — nếu không thì race chỉ chuyển từ "tranh chỗ" sang "nhảy thứ tự tab"); hạ tầng manifest sandbox entry + postMessage RPC bridge (**toàn bộ** API phải relay) + tab bar UI + vòng đời iframe per script.

- **Xong khi**: một script chạy trong sidebar tab của nó, thao tác được trang qua `page.*` API, và **bị chặn thật** khi `page.dom` không được cấp.
- **Phụ thuộc**: Phase 3 phải có consumer thật trước — cái rẻ phải chứng minh nhu cầu trước khi làm cái đắt.

---

## Khu vực Open Points

Điểm nghẽn, việc chưa chốt hướng, rủi ro mở. Đọc trước khi bắt việc mới trong khu vực tương ứng. Checklist "chưa verify bằng browser thật" nằm riêng ở [TEST_PLAN.md](TEST_PLAN.md).

### Chưa implement / chưa chọn hướng

- **[§7.3-open] Anchor badge cho MSE/HLS player vẫn KHÔNG hoạt động ổn định, sau 3 vòng vá dựa trên đọc code** (3 bug đã vá ở [CHANGELOG.md](CHANGELOG.md#73a-hls-bug-thật--3-vòng-vá-vấn-đề-vẫn-còn)) — user xác nhận vấn đề gốc VẪN CÒN Y NGUYÊN. Side Panel (qua `webRequest`, độc lập với DOM/MSE correlation) vẫn phát hiện + tải được đúng; chỉ riêng badge neo vào `<video>` là sai/thiếu. **Việc tiếp theo BẮT BUỘC phải có debug trực tiếp trên trang thật** (`console.log` tạm trong `hls-global-hook.ts`/`dom-media-observer.ts`, hoặc đơn giản hơn: kiểm `el.getAttribute('data-synapse-hls-url')` qua DevTools của TRANG đó) trước khi vá thêm bất kỳ giả thuyết nào nữa — **dừng đoán mò dựa thuần trên đọc code.** Đường tổng quát hơn (né cả lớp correlation-đoán-mò): §7.3(b)/§10.3 hook `SourceBuffer.appendBuffer`. Escape hatch đã có cho user: `pipeline.hook('media.correlate-url', …)` cho tự viết logic riêng theo site — không thay thế việc debug thật.
  - **Dữ liệu mới từ lượt test Tier 2 (bilibili.tv), cùng họ triệu chứng nhưng khác nguyên nhân:** cơ chế fire/relay của `pipeline.hook` xác nhận ĐÚNG (handler chạy, nhận đúng ctx) — nhưng badge `ui.badge()` vẽ ra lệch vị trí trên CHÍNH bilibili.tv, đúng vị trí trên trang khác. Khác 3 bug đã vá (những cái đó là sai/thiếu TÍN HIỆU tương quan, tức không tìm ra URL đúng) — đây là tìm ra URL đúng rồi, chỉ riêng bước NEO badge vào toạ độ màn hình sai. Nghi CSS của trang (`transform`/`zoom` trên `<html>`/`<body>`) phá vỡ giả định "host là con trực tiếp của `documentElement` nên `position:fixed` luôn tính theo viewport" mà `ui-compositor.ts`'s `trackBadges()` dựa vào — **CHƯA xác nhận root cause.** Là bug của LỚP badge-anchoring nói chung, có thể ảnh hưởng mọi badge trên trang có kiểu CSS này, không riêng HLS/MSE hay Tier 2.
- **[API parity với builtin] Sức mạnh của một builtin phải truyền tải được TOÀN BỘ qua `synapseApi` — hiện chưa, và đây là nợ kiến trúc chứ không phải thiếu sót lặt vặt.** §11 định vị builtin là **reference implementation**, không phải một tầng đặc quyền vĩnh viễn. Nếu builtin làm được X mà không script nào làm được X, thì định vị đó sai — builtin đang là tầng đặc quyền thật, chỉ là chưa ai gọi tên. Khoảng cách đo được hôm nay:

  | Builtin | Script với tới được | Còn thiếu |
  |---|---|---|
  | `http-error-mocker` | `fake-response` × `main-world` — **1 trong 6** tổ hợp action×mechanism đã ship | `block`, `rewrite-request`; mechanism `debugger`, `dnr` |
  | `network-sniffer` | `media.list/inspect/download/job/control` | **quan sát request dạng subscription** (`net.observe`) — 2 trong 3 nguồn phát hiện; `iframe-unsandbox`; toggle turbo |
  | `reader-mode-converter` | gần như đủ — đã chứng minh bằng [test-lib-reader-mode.js](examples/test-lib-reader-mode.js) | chỉ thiếu crawl-site, **cố ý** (policy nghiệp vụ, không phải năng lực) |

  **Cách đóng khoảng cách này KHÔNG phải là mở `mechanism` cho script tự chọn.** Lý do khoá nó vẫn đúng (xem [`features/http-mock/.domain.md`](../src/adapters/browser-extension/features/http-mock/.domain.md)): để script tự chọn mechanism là đẩy toàn bộ ma trận ràng buộc mechanism×action vào tầng phân quyền, nơi một tổ hợp sai biến thành lỗi *permission* thay vì lỗi validate. Hướng đúng: **script khai ý ĐỊNH (`block`/`rewrite`/`fake`), platform vẫn chọn mechanism** — đúng nguyên tắc "phân quyền theo mục đích, không theo cơ chế" đã chốt ở [design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract). Chi phí thật nằm ở chỗ platform phải tự giải ma trận đó (chọn mechanism rẻ nhất còn hỗ trợ được action đang xin), không ở chỗ thêm field.

  **Liên đới:** đây chính là blocker của "[§12.4+] Builtin nghỉ hưu hẳn" bên dưới — không thể xoá builtin khi template thay thế nó chỉ làm được 1/6 việc. Và nó cũng quyết định mức độ trung thực của mỗi template's dòng "chưa làm được".
- **[§11.6] Catalog scope đề xuất 8 enforced + 2 disclosed ([api-inventory.md §5](api-inventory.md)) — chưa chốt.** Đếm thô cả hai trục ra ~13, vỡ trần ~10 ([design.md §12](design.md#12-automation-model-scopes-with-resource-match-secrets-and-pipeline-hooks)). Cách gộp đã chọn: **giảm chiều số lượng bằng chiều tài nguyên** (×match giới hạn thiệt hại tốt hơn chẻ nhỏ scope). Hai quyết định gộp còn tranh cãi: `media.read`+`media.download` gộp làm một (tách ra là nghi thức 2-prompt mà ai cũng Allow cả hai); `tabs.open` bỏ hẳn khỏi v1 (`window.open` đã có sẵn, delta chỉ là popup blocker).
- **[§11.3] Đường dispatch "gọi `run(input)` của một uploaded module" trong shim trailer NGHI LÀ CHẾT — chưa verify, chưa có caller.** Nghe `chrome.runtime.onMessage` bên trong USER_SCRIPT world, nhưng Chrome định tuyến chiều user-script→extension sang `onUserScriptMessage` và không có đường ngược lại được ghi trong tài liệu. Hôm nay không ai gửi tới nó nên chưa gây hại. Cố ý KHÔNG xoá vội (xoá là âm thầm bỏ một capability đã ghi trong doc); **nếu thêm caller thì phải verify end-to-end trên Chrome thật TRƯỚC, đừng tin là nó chạy.** Spike subscription (`media.onProgress`) KHÔNG trả lời được câu này — nó đi vòng qua `onMessage` hoàn toàn (dùng DOM CustomEvent), nên chứng minh có đường push khác vào world, không chứng minh (hay bác bỏ) `onMessage` cụ thể có fire hay không.
- **[§11.4] Thứ tự icon hiện theo `ownerId`, mà `ownerId` của script upload là uuid — ổn định nhưng vô nghĩa với người dùng.** Sắp theo id là thứ duy nhất hai world tính ra giống nhau mà không cần chia sẻ state, và đúng mục tiêu "không bao giờ theo thứ tự khởi tạo". Kế hoạch gốc ghi "theo tên script" — cần tên ổn định, tức §12.1 (`synapse:script-meta`), **nay đã có**. Việc còn lại: đổi khoá sắp xếp sang `resolveScriptLabel()`, giữ `ownerId` làm tie-break (2 script trùng tên vẫn phải tất định).
- **[§11.2] Phần I/O của download engine không có test, và CỐ Ý sẽ không có.** 61 test chỉ phủ phần PURE đã tách ra `shared/download/`. `features/media/download/*.offscreen.ts` (OPFS, ffmpeg.wasm, `chrome.*` relay, 3 vòng lặp job) không test được trong `environment: 'node'` và không đáng dựng harness riêng — lưới an toàn thật vẫn là test bằng browser thật. **Hệ quả cần nhớ khi sửa tiếp: mọi thay đổi trong 3 job kind sẽ KHÔNG bị `npm test` chặn lại.**
- **[§10.2] Ad-filter cho stream trực tiếp — làm SAU §10.1.** Cố ý chưa lọc (cần case thật để hoàn thiện logic bắt link trước). Đã biết: 3 nguồn phát hiện bất đồng (webRequest thấy `initiator` thật của iframe quảng cáo, MAIN-world/DOM chỉ thấy `pageUrl` trang chủ → cùng 1 stream lọt/bị chặn tuỳ nguồn nào bắt trước — không nhất quán, không phải bug); không thêm domain sạch vào denylist, cần tín hiệu khác (initiator frame, quan hệ với VAST/VPAID đã thấy trên trang).
- **[§10.3] Media MSE không lộ manifest — lớp URL chưa từng bắt được.** Player tự viết lấy chunk từ endpoint JSON thường (không phải `.m3u8`/`.mpd`); magic-bytes không nhận `moof`/`styp` fMP4 media segment (chỉ có `ftyp` init segment); `probedMagicByteOrigins` đánh dấu vĩnh viễn bất kể kết quả, dễ "đốt" origin oan. Sửa nhanh chưa làm: (i) chỉ đánh dấu probe khi thật sự vô ích / cap theo số lần; (ii) thêm `styp`/`moof` vào magic-bytes như kind mới. Đường tổng quát thật sự vẫn là §7.3(b).
- **[§7.3(b)] Hook `SourceBuffer.appendBuffer` để bắt byte trực tiếp — hoãn.** Mệnh đề cũ "chưa gặp ca thật nào bắt buộc" **nay đã sai** — §10.3 chính là ca đó. Đánh đổi cũ vẫn đúng: chỉ lấy phần đã phát, không nhanh hơn real-time, tốn kênh structured-clone, cần remux nếu nhiều SourceBuffer.
- **[§8 mở rộng] Offscreen Document idle timeout — đã chốt hướng, chưa implement.** Tự đóng sau N giây (đề xuất 60s) không còn job active, giảm RAM cho singleton hiện "stay alive" vô thời hạn. **Điều kiện bắt buộc trước khi đóng**: không job nào ở trạng thái ngoài `done`/`error`/`cancelled` — đóng giữa `'paused'` mất toàn bộ `JobControl` sống trong RAM (chỉ HLS non-live có checkpoint §8.12 sống sót; turbo và live-capture mất trắng). Timer reset mỗi lần có job mới hoặc event `progress`.
- **[Storage lifecycle] GC / TTL cho dữ liệu lưu trữ — đã chốt hướng (auto-delete, TTL configurable), chưa implement, chưa chọn nơi đặt config UI.** Áp trước tiên cho Review sessions (IndexedDB blob-store, không giới hạn tuổi hôm nay) và `DownloadJobCheckpoint` mồ côi. Cần: default TTL (đề xuất 7 ngày) + sweep định kỳ qua `chrome.alarms` (Service Worker/Offscreen không sống đủ lâu để `setTimeout` dài hạn) + **một nơi để user chỉnh TTL** — hiện KHÔNG có trang "Global Settings" nào (Dashboard scoped per-`moduleId`). Quyết định nơi đặt là điều kiện chặn phần UI, **KHÔNG chặn phần sweep backend** (ship trước với TTL hardcode được).
- **[Kiến trúc UI] Pub/Sub State Manager tập trung — vẫn là OPEN POINT, KHÔNG phải quyết định làm.** Mỗi view tự fetch state trực tiếp, không có store trung tâm broadcast khi state đổi ở nơi khác (sửa ở Dashboard, Popup đang mở song song không tự cập nhật). **Chưa có case đau cụ thể nào buộc phải làm** — trước khi cân nhắc implement, cần xác định: có đang thật sự gây desync NHÌN THẤY ĐƯỢC trong sử dụng thật không, hay chỉ là lo xa kiến trúc chưa có bằng chứng.
- **[§11.6 Tier 4] Workflow engine kiểu DAG (Prefect-like) — ĐÃ CÂN NHẮC, HOÃN.** Không vào plan. Lý do: (a) trong pipeline tuần tự mà mỗi bước là hàm JS, phân nhánh là `if` và loop là `for` **bên trong** một bước — DAG tường minh chỉ đáng khi có thứ *tiêu thụ* cấu trúc đó (scheduler phân tán: không cần; visualizer: đã có cho pipeline tuyến tính); (b) 5/6 value prop của Prefect không áp dụng (song song hoá, retry, cron, resume đều đã có theo cách khác) — chỉ **observability** là khoảng trống thật, và Tier 3 lấp được mà không cần DAG; (c) **mâu thuẫn kiến trúc**: node ở context khác nhau biến mọi cạnh thành ranh giới structured-clone, trong khi pipeline chạy tốt nhất (`reader-mode-converter`) truyền một **`Document` sống** qua cả 4 bước — thứ đó không qua được ranh giới, nó chạy được CHỈ VÌ cả 4 bước cùng world. **Điều kiện vào lại**: có ≥2 ca thật mà `if`/`for` trong một bước không diễn đạt nổi, VÀ các bước đó cùng context.
- **[§12.4+] Builtin nghỉ hưu hẳn, thay bằng script thường editable — Ý TƯỞNG, CHƯA CHỐT PHASE.** Đúng định vị playground, builtin không nên là tầng đặc quyền vĩnh viễn ngay cả sau khi có nút Clone. Cái chặn KHÔNG phải số phase mà là **parity năng lực** — xem mục "[API parity với builtin]" ở đầu khu vực này cho bảng đo khoảng cách; tóm tắt các blocker cụ thể: `network-sniffer` cần `net.observe` dạng subscription (chặn cứng chưa thiết kế — xem ghi chú dispatch nghi chết ở [§11.3] trên); `http-error-mocker` cần `action:'block'`/`rewrite` + 2 mechanism còn lại; `reader-mode-converter` cần platform expose thêm. **Đừng gán cứng "Phase N" trước khi 3 mục trên có ngày xong thật.** Điều kiện vào lại: track API đủ để cả 3 template đạt hành vi tương đương builtin, RỒI mới lên lịch xoá + xử lý migration `activation[id]`.
  - **Blocker thứ 4 (mới, sau khi Tier 2 `pipeline.hook` ship): `media.correlate-url` hôm nay do PLATFORM sở hữu** (`KNOWN_PIPELINE_SLOTS` whitelist phẳng + `scope: 'media'` tĩnh). Nghỉ hưu `network-sniffer` nghĩa là slot này mất chủ, TRỪ KHI mô hình "ai được khai slot" tổng quát hoá từ platform-only sang "bất kỳ pipeline nào, kể cả template script user viết". Cơ chế xuyên world đã tổng quát sẵn (không quan tâm ai sở hữu slot), chỉ 2 phần gắn cứng cần đổi — nhưng đây không phải một dòng code: nó mở ra **mô hình tin cậy 3 bên chưa có câu trả lời** — (a) **namespacing**: slot cần khoá theo `ownerModuleId` (hai script không liên quan cùng đặt tên bước sẽ đụng nhau, không còn platform làm trọng tài duy nhất); (b) **ai cho phép hook**: với slot platform, "platform quyết định expose chỗ này an toàn" là neo tin cậy ngầm — với pipeline của script A không có neo đó, cần A **chủ động khai slot mình là hookable**; (c) **scope**: không có scope tự nhiên nào cho "cho phép script khác chỉnh pipeline CỦA TÔI". **Điều kiện vào lại riêng**: Tier 3 ship trước, VÀ có case thật cần hook một pipeline user tự viết — chưa có caller thật thì chưa thiết kế (đúng nguyên tắc đã áp cho DAG engine).
- **[§3] `http-error-mocker` chưa ghép vào Composite Module nào** — cố ý, chưa có chuỗi input/output hợp lý, chờ nhu cầu thật.

### Rủi ro / quyết định mở

- **[BẢO MẬT — ĐÃ VÁ ở Phase 2] `cache` từng là đường leo thang đặc quyền.** Grant lưu ở `synapse:grants` trong `chrome.storage.local` + `services/cache.ts` là `chrome.storage.local` trần không namespace + `rpc-handler` truyền thẳng `req.args` vào service ⇒ script được cấp `cache` chỉ cần `cache.set('synapse:grants', …)` là tự cấp mọi capability. Vá bằng **hai** thay đổi độc lập, **giữ cả hai khi sửa tiếp**: (1) namespace `script:<moduleId>:` với `moduleId` lấy từ transport; (2) `rpc-handler` không route service key-value trần nào, fail-closed với mọi thứ ngoài `API_METHODS`. Đã có test đúng ca tấn công cũ (`script-storage.test.ts`). Chi tiết ở [design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract).
- **[§6.4]** Side Panel do Chrome quản lý **per-window, không phải per-tab** — hành vi khi đổi tab/window trong cùng cửa sổ chưa kiểm tra kỹ ngoài việc filter theo origin.
- **[§8.11]** Bản vá relay 3 kênh mới (query-replay-headers / sync-header-replay-rule / describe-header-replay / trigger-download) **CHƯA được re-verify bằng browser thật** — cần xác nhận không bị listener khác giành response, và header replay thật sự hoạt động trên site hotlink-protect thật.
- **[§8.12]** Checkpoint không có giới hạn tuổi (chưa quyết có cần TTL không). Gap phát hiện khi implement, chưa xử lý: một checkpoint mà `DetectedMedia` gốc đã bị dismiss/evict (cap `MAX_DETECTED_ITEMS=200`) **không còn bề mặt UI nào để resume HAY dọn** — Side Panel chỉ match checkpoint theo `item.id` của entry đang hiển thị, nên checkpoint đó (và file OPFS mà sweep tiếp tục spare vì nó) sống mãi trong storage.
- **[§8.6]** §7.1 (header replay) và §8.2 (Turbo Range) đều phát request từ context extension → cùng câu hỏi "DNR có áp lên request của chính extension không". Đã verify qua §7.1, **dùng chung kết luận cho §8.2** (chưa verify riêng).
