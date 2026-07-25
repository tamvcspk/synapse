# Roadmap

Trạng thái các hạng mục đang xét, dùng làm state memory giữa các phiên làm việc. Không phải build spec — khi bắt tay implement một mục, đọc lại quyết định đã chốt bên dưới trước khi code.

## 1. Reader Mode Converter — Đã implement (Composite Module, 4 bước + Review/ZIP page)

- **`HtmlToMarkdownConverter`** ([shared/html-to-markdown.ts](../src/shared/html-to-markdown.ts)) là wrapper quanh **Turndown** (không tự viết renderer) — hai custom rule resolve `src`/`href` tương đối→tuyệt đối (Turndown không tự làm), options cố định để khớp output cũ (`headingStyle:'atx'`, `bulletListMarker:'-'`, `codeBlockStyle:'fenced'`, `hr:'---'`). Dependency mới `turndown`+`@types/turndown`, cần `esModuleInterop: true` (đã verify runtime: default import ra đúng class, namespace import fail ở `new X()`). `isHiddenElement` dựa attribute/inline-style, không dựa `offsetWidth` (đúng cho cây DOM tách rời).
- **4 bước tuần tự qua `createCompositeModule`:** `load-dom` → `clean` → `fetch-images` → `convert-markdown`, dùng chung một shape tích luỹ nên bypass 1 bước qua Dashboard's Steps view (mục 3) tự động an toàn.
  - `clean` dùng **`@mozilla/readability`** (không phải heuristic tự viết) — mutate document nó nhận nên `load-dom` clone trước; custom serializer trả thẳng DOM Element; Readability tự chuẩn hoá `<img>`/`<a>` thành URL tuyệt đối.
  - `fetch-images`: `fetch()` thẳng trong content-script (host_permissions đã cấp cross-origin), per-image try/catch (graceful fail), cap ~10MB/ảnh, dedupe theo URL tuyệt đối.
  - `convert-markdown`: `Map<absoluteUrl, localPath>` → `resolveImageUrl`; title ưu tiên Readability's title.
  - Auto-run smoke test ở `content-scripts/index.ts` loại trừ module này (fetch-images không còn "rẻ" để tự chạy mỗi lần load trang).
- **`UIActionSchema` tổng quát hoá thành mảng `actions[]`** ([ui-schema.ts](../src/kernel/ui-schema.ts)) để hỗ trợ action Crawl bên dưới.
- Dependency mới `@mozilla/readability` — ngoại lệ chấp nhận so với "không thêm dependency" (thư viện chuẩn ngành cho đúng bài toán).
- **Chưa làm (cố ý):** bước thứ 5 nhận diện ảnh-là-diagram → convert qua Mermaid.

### Crawl & Convert Site (action thứ 2)

Action thứ 2 trên cùng Module (đã cân nhắc và loại phương án Module/Crawler riêng), dùng lại 100% Review/ZIP page.

- **Discovery:** `robots.txt`'s `Sitemap:` trước, fallback `/sitemap.xml`; nếu không có, auto-expand `nav[aria-expanded="false"]` rồi đọc `<a href>`. Same-origin only, `MAX_CRAWL_PAGES=200`.
- **Quyết định kiến trúc quan trọng nhất: `fetch()` + `DOMParser`, không phải `chrome.tabs` navigate** — `LoadDomStep` duck-type input đã là `ReaderPipelineValue` thì trả nguyên, cho phép tái dùng y nguyên `clean`/`fetch-images`/`convert-markdown` cho trang remote. Đánh đổi chấp nhận: trang thuần client-rendered (không SSR) ra markdown rỗng/thưa, graceful không chặn cả crawl.
- Tuần tự từng URL, delay ~200ms, fire-and-forget progress ping cho popup's busy view (mới, dùng chung cho mọi action).
- **Output file-per-page, không phải 1 file gộp** (đổi sau khi test angular.dev ra 200 trang, 1 file gộp 10k+ dòng không dùng được) — `{title, pages:{path,title,markdown}[], files}`, dùng chung cho cả 2 action. `pathFromUrl`+`slugify()` mô phỏng cấu trúc site thật; `uniquePagePath` de-dupe.
- Đánh đổi chưa xử lý: đóng popup giữa chừng lúc crawl mất kết quả (response chỉ 1 lần lúc kết thúc).

### Review page + ZIP download

Kết quả `resultView:'files'` mở Tab riêng (print-preview text thô, không render markdown→HTML), không còn inline trong popup.

- Handoff qua `review-handoff.ts`: ảnh → IndexedDB (`blob-store.ts`), text nhỏ → `chrome.storage.session` (one-shot).
- 1 trang: `<input>` tên file editable. Nhiều trang: `<select>` chọn xem/sửa nội dung (path không sửa được), giữ edit khi chuyển trang.
  - **Bug đã sửa:** `slugify` từng xoá sạch ký tự có dấu tiếng Việt thay vì bỏ dấu — `stripDiacritics()` giờ NFD-normalize rồi lọc combining marks (`đ`/`Đ` thay trực tiếp, không có phân rã canonical). Sống ở [`shared/slugify.ts`](../src/shared/slugify.ts), dùng chung với crawl's `pathFromUrl`.
  - **Bug đã sửa:** double-prefix `images/images/...` trong zip.
  - Zip filename (`${slugify(title)}.zip`) tách khỏi tên file `.md` của trang đơn.
- **ZIP tự viết** ([shared/zip.ts](../src/shared/zip.ts), Global SDK, không dependency) — method STORE (không nén, ảnh đã nén sẵn), CRC32 + local header + central directory + EOCD tự viết.

## 2. Module Registry UI — Đã implement

- Declarative UI Schema ([kernel/ui-schema.ts](../src/kernel/ui-schema.ts)): `UISchema = UICollectionSchema | UIActionSchema` (discriminate bằng `kind`), `CollectionCommand<T>` là wire shape chung cho Bus write path.
- `chrome-module-registry.ts` gộp `BUNDLED_MODULES` + `BACKGROUND_MODULES` khi build entries — module `bus`-only (như `http-error-mocker`) mới có `RegistryEntry`/Slide Toggle.
- **Rule đã chốt: không dùng `<dialog>` trong popup** — Chrome MV3 popup clip native `<dialog>.showModal()` (top layer không tham gia auto-size), nút Cancel/Close có thể render ngoài vùng nhìn thấy. Toàn bộ popup chuyển sang in-flow view-swap qua `router.ts`'s `View` union.
- Popup + Dashboard đều VanJS + Pico.css (xem mục 2.5).

### Navigation Flow (đã chốt)

```
[MÀN HÌNH CHÍNH: LIST MODULES]
       │
       ├──► Module KHÔNG có Setting ──► Chỉ có Slide Toggle
       │
       └──► Module CÓ Setting ────────► Slide Toggle + Icon "Gear/Arrow"
                                               │ (click Module hoặc Icon)
                                 [MÀN HÌNH CẤU HÌNH CHI TIẾT]
```

- **Hai hành vi của icon:** Collection/CRUD schema (vd `http-error-mocker`) → mở Management View (nay là Dashboard tab riêng, xem 2.5). Action schema không có config để lưu (vd `reader-mode-converter`) → click icon **trigger thẳng `run()`**, hiển thị kết quả tại chỗ. Registry phân biệt qua shape của schema, không phải một boolean "hasConfig".

## 2.5. Trang Quản lý Nội bộ Độc lập — Đã implement (VanJS, không phải Alpine.js)

- **Vì sao không Alpine.js:** MV3 CSP không cho `unsafe-eval`; Alpine evaluate directive-string qua `new Function()` → fail cứng. VanJS là lời gọi hàm TS thuần, parse 1 lần ở build time, không runtime eval nào để CSP chặn.
- Pico.css giữ nguyên (thuần CSS, không liên quan CSP/eval). Vendor qua npm, không CDN.
- Layout dùng chung [ui/](../src/adapters/browser-extension/ui/): `ui/popup/` + `ui/dashboard/` (mới) + [ui/module-data-sources.ts](../src/adapters/browser-extension/ui/module-data-sources.ts) dùng chung cả hai.
- **`router.ts`'s `'management'`/`'item-form'` View đã xoá hẳn khỏi popup, không giữ fallback** — tránh hai renderer độc lập cùng đọc một `UISchema` dẫn tới drift. Popup chỉ `chrome.tabs.create` mở Dashboard rồi tự đóng.
- Lưu trữ: mỗi module tự sở hữu `chrome.storage.local`, không cơ chế mới, không IndexedDB (dữ liệu Collection-schema chỉ là JSON nhỏ).
- **`listCollection()` trên Module tự đăng ký** (kernel/module.ts) — fix boundary violation ban đầu (`module-data-sources.ts` từng hardcode `if (id==='http-error-mocker') import(...)`). Module mới không cần sửa `module-data-sources.ts`.
- **Manifest/build entry:** không field manifest nào khớp trang mở qua `chrome.tabs.create` thuần — khai `ui/dashboard/index.html` như Rollup input thường trong [vite.config.ts](../vite.config.ts), độc lập với crx's manifest-driven emission.

## 2.6. Nâng cấp Network Interceptor (`http-error-mocker`) — Đã implement (3 mechanism)

- **Vấn đề cốt lõi:** patch cũ ở MAIN world không chạm network stack thật → không hiện trong tab Network, không bắt được request "file" (ảnh/script/download) không qua fetch/XHR.
- **`service-worker` mechanism bị loại — không khả thi:** `navigator.serviceWorker.register()` bắt buộc `scriptURL` cùng-origin với trang gọi — một extension chặn trang của người khác không có cách tự phục vụ script từ origin đó (khác MSW, tự sở hữu origin).
- **Đa cơ chế song song qua field `mechanism`** ([shared/http-mock.ts](../src/shared/http-mock.ts)), dùng chung 1 shape `MockConfig`:
  - **`main-world`:** rẻ nhất, không banner, nhưng không hiện Network tab, chỉ mock fetch/XHR.
  - **`debugger`:** CDP `Fetch.enable`/`fulfillRequest`/`continueRequest`, request thật đi qua network stack nên hiện đúng Network tab, bắt mọi loại request — nhưng Chrome hiện banner "đang debug tab" liên tục (đánh đổi đã chấp nhận).
  - **`dnr`:** native declarativeNetRequest, không banner, nhưng hoàn toàn khai báo (không callback per-request). `block`/`rewrite-request` (chỉ URL/header, không đổi được body/method — giới hạn cứng của API)/`fake-response` (redirect sang `data:` URL — giả định `data:` được chấp nhận làm redirect target, đã verify đúng qua test thật). `fakeStatus`/`rewriteMethod`/`rewriteBody`/`requestMatchContains` đều bị ẩn khỏi form + validation-reject cho `dnr` (giới hạn cứng của API, không phải bug) — dùng `showWhen` dạng mảng AND (kernel-level, mục 2.6.1). Rule ID băm FNV-1a từ `MockConfig.id`. Một rule = một action (redirect và modifyHeaders phải tách 2 rule dùng chung condition).
- **Rewrite URL với file tĩnh đóng gói sẵn** ([mock-files/](../src/adapters/browser-extension/background/modules/http-error-mocker/mock-files)): enumerate ở BUILD time qua `import.meta.glob`. Vite inline file <4KB thành `data:` URI, file lớn hơn emit riêng dưới `assets/` — `mock-files.ts` xử lý cả hai dạng. **`web_accessible_resources` không tự động cho asset thường** — phải khai tay `{resources:['assets/*'], matches:['<all_urls>']}` (scope theo pattern, không theo tên file cụ thể vì Vite content-hash).
- `UIFieldDef.suggestions?: {label,value}[]` (kernel, mới) — `<datalist>` gợi ý cho field text, không ép giá trị như `enum`.

### 2.6.1. Mở rộng — Rewrite Request, cấu hình sâu debugger, fake file qua upload — Đã implement

- **`showWhen` hỗ trợ mảng điều kiện (AND)** (kernel, [ui-schema.ts](../src/kernel/ui-schema.ts)) — sửa tận gốc bug field bị validation-reject cứng cho `dnr` vẫn hiện trong form. `mechanism`/`action` giờ đều là controller field hợp lệ cho field khác.
- **`action` mới trên mỗi rule: `'fake-response' | 'rewrite-request' | 'block'`.** Giới hạn theo mechanism: `main-world` chỉ patch được `window.fetch`/`XHR` (không sửa được `<script src>`/`<img>`/dynamic `import()` — giới hạn triệt để của JS-level patch, không phải bug); `debugger` rewrite được MỌI resource type (network-stack thật); `dnr` (khi có) chỉ URL+header.
  - **`requestMatchContains` cho XHR dưới main-world — two-phase evaluate:** `open()` (chưa có body, chỉ quyết định url/method) rồi `send()` (có body, quyết định cuối) — giới hạn còn lại: không thể vừa match theo body vừa đổi URL/method (ràng buộc cứng của chính XHR's open()-trước-send()).
- **Advanced panel collapsible** (`UIFieldDef.advanced?: boolean`, kernel-level) — ẩn hẳn khi rỗng.
- **Fake file qua upload, 2 đường lưu trữ:** `debugger` → IndexedDB (`blob-store.ts`, không giới hạn ~5MB); `main-world` → inline base64 ngay trong `MockConfig` (cap 2MB client + backstop server) — **quyết định đơn giản hơn ý tưởng ban đầu** (blob: URL cross-world, chưa verify chắc dereference được) vì tự động đi theo cơ chế storage-sync sẵn có, không cần kênh relay mới. 1 field kernel `type:'file'` + `fileInlineKey`/`fileNameKey` dùng chung cho cả hai đường lưu.
- **Chưa làm:** `rewriteBody` qua file (chỉ `fakeResponse` được hỗ trợ upload).

## 3. Module Chain (Composite Module) — Đã implement (chỉ bản tuần tự)

- **Không rollback:** [kernel/composite-module.ts](../src/kernel/composite-module.ts)'s `createCompositeModule` — sub-module throw bị bắt per-step, báo qua `onSubFailure`, `value` giữ nguyên trôi sang bước kế (bypass), không lùi state.
- **Không Context Share mutable** — `ctx` forward nguyên xuống mọi `sub.run`, chỉ trao đổi qua `value`/`ctx.services`.
- `RegistryEntry` thêm `subModules`/`subState` (thiếu key = active). **UI sub-toggle chuyển từ popup sang Dashboard** (đổi sau khi thấy Reader Mode có 4 bước, popup quá chật) — popup chỉ còn nút "Steps" mở Dashboard's steps view.
- Composite Module nghiệp vụ thật đầu tiên: `reader-mode-converter` (mục 1).
- **Chưa làm (cố ý, chờ nhu cầu thật):** `http-error-mocker` chưa ghép vào Composite Module nào — không có chuỗi input/output hợp lý.

## 4. Generic Network Sniffer / Shadow DOM popover — Đã implement

Action-button paradigm tách riêng, xem mục 4.3.

### 4.1. Generic Network Sniffer (`network-sniffer`) — Đã implement, 3 nguồn phát hiện

Business case: phát hiện URL video/audio/stream trang tự request, liệt kê, cho tải về.

- Background Module (`needs:['bus','cache']`, không `dom` — `chrome.webRequest` chỉ dùng được ở background). Tái dùng nguyên Collection-schema + Management View thay vì xây RPC mới cho "bus-only Module trigger+nhận kết quả".
- **`webrequest-media-observer.ts`** (mechanism-only, Global SDK-adjacent): bọc `chrome.webRequest.onHeadersReceived` (`extraInfoSpec:['responseHeaders']`, non-blocking), lọc `types:['media','xmlhttprequest','object','other']`. Không biết gì về "thế nào là media".
- **`shared/media-url-matcher.ts`:** `classifyMediaUrl` (theo đuôi file) + `classifyMediaMimeType` (theo Content-Type, prefix-match `video/*`/`audio/*` + exact-match MIME manifest HLS/DASH) — cả hai cố tình loại trừ đuôi/MIME segment (`.ts`/`.m4s`, `video/mp2t`): một stream có thể bắn hàng trăm segment request, không đáng liệt kê và không tự tải về dùng được.
- Danh sách chạy dồn (running log) qua mọi tab, cap 200, dedupe theo `url` — không scope theo "tab đang xem" (Dashboard tự nó là "tab đang active" khi mở).
- `uiSchema`: Collection read-only + `rowActions` (Download qua `chrome.downloads.download` thẳng trong `management-view.ts`, Dashboard đã có full `chrome.*`). Permission mới: `webRequest`, `downloads`.

**Junk-URL filtering (Content-Type + resource-type trust split) — đã implement:** nhánh `xmlhttprequest`/`object`/`other` (không phải `'media'`) là nơi false positive tới từ (ad/analytics XHR có URL trông giống media). Đổi mechanism `onBeforeRequest`→`onHeadersReceived` để đọc `Content-Type` thật. Trust split (`classifyDetection`, [network-sniffer/index.ts](../src/adapters/browser-extension/background/modules/network-sniffer/index.ts)): `resourceType==='media'` giữ hành vi cũ (Content-Type ưu tiên, fallback URL-extension); nhánh ồn bắt buộc Content-Type khớp thật, **trừ `stream`-kind** (`.m3u8`/`.mpd`) — luôn tin theo đuôi URL vì ad network gần như không bao giờ dùng đuôi manifest, và nhiều manifest server trả Content-Type không chuẩn (phát hiện được sau khi thấy filter này chặn nhầm manifest thật của player MSE-based). Side effect: request lỗi trước khi có response không còn được ghi nhận (cải thiện phụ).

**MAIN-world manifest/media observer (nguồn thứ 3) — đã implement:** player MSE-based (`<video src="blob:...">`) không lộ URL thật ra ngoài — cả webRequest lẫn DOM sniffing đều mù, trong khi ad `.mp4` trần vẫn lọt filter. Tái dùng nguyên `main-world-interceptor` pattern, **observe-only** (`evaluate` luôn trả `{intercept:false}`, side-effect báo URL qua `createMainWorldChannel` chiều MỚI: MAIN world dispatch, ISOLATED world listen). Đã verify an toàn khi chạy song song `http-error-mocker`'s MAIN-world interceptor (hai script độc lập tự chain đúng, capture "fetch hiện tại" tại thời điểm gọi). `dom-media-observer.ts` nghe TRỰC TIẾP cùng channel (chung `window` khi cùng top frame — iframe lồng tự nhiên không nhận được gì, không cần logic loại trừ riêng) để correlate URL quan sát được với `<video src="blob:...">` cho badge anchoring — **heuristic "lần quan sát gần nhất" là TOÀN CỤC, không phải khớp theo từng phần tử** (trang nhiều player MSE cùng lúc sẽ lẫn lộn; khớp chính xác cần intercept MediaSource/SourceBuffer, nặng hơn hẳn, chưa làm — xem mục 5.1). Click badge correlated tải thẳng URL đã correlate.

**Third-party/initiator-origin signal — đã implement:** `DetectedMedia.thirdParty?: boolean`, cố tình là NHÃN không phải filter loại trừ (video hợp pháp cũng thường serve từ CDN khác origin — loại trừ cứng sẽ lặp lại đúng sai lầm đã sửa ở filter Content-Type). `chrome.tabs.get(tabId)` so hostname với `initiator`; chỉ tính cho nhánh webRequest.

**DOM sniffing (nguồn thứ 2) — đã implement:** bắt `<video>`/`<audio>` đã có trong DOM nhưng chưa request thật (lazy player, `preload="none"`). Re-validate server-side, không tin thẳng content-script. Không xử lý `blob:` (đúng, xem MAIN-world observer ở trên bù lại phần này).

**Phủ nested/cross-origin iframe (kỹ thuật IDM/Cốc Cốc) — đã implement, 3 phần:**
- **Part A:** DOM detection tách sang content_scripts entry riêng `all_frames:true` ([frame-media-observer.ts](../src/adapters/browser-extension/content-scripts/frame-media-observer.ts)) — giữ entry gốc top-frame-only vì `chrome.tabs.sendMessage` không kèm `frameId` sẽ broadcast mọi frame, dễ race với Action-schema dispatch nếu gộp chung.
- **Part B:** toggle module có tác dụng ngay — `pingBusModule(id)` bắn ngay sau khi ghi storage, dùng chung mọi bus Module.
- **Part C:** Module mới `iframe-unsandbox` (toggle riêng, mặc định OFF — cố tình không gộp `network-sniffer`, mức xâm lấn khác hẳn quan sát thuần). Thêm token `allow-scripts`/`allow-same-origin` còn thiếu vào `<iframe sandbox>` (cascade tự nhiên qua nhiều tầng nhờ Part A) + DNR rule rút header `Content-Security-Policy` khỏi mọi response `sub_frame` (`dnr-network-rules.ts` đổi thành owner-scoped, không còn sole-owner, để `http-error-mocker` + `iframe-unsandbox` cùng dùng DNR không đụng rule nhau). **Đánh đổi cố tình để lộ rõ:** DNR chỉ điều kiện theo TÊN header, rút CSP của MỌI iframe trên MỌI site suốt thời gian bật, không riêng iframe liên quan media — lý do chính phải tách toggle riêng, mặc định OFF.

### 4.2. Shadow DOM popover (In-Page Float Widget) — Đã implement (case đầu: `network-sniffer`)

- **`uiParadigm` field** trên `Module`/`RegistryEntry` (`'none'|'dedicated-page'|'float-widget'|'action-button'`) — gắn generic tooltip hint ở list-view popup, không hardcode theo module id.
- **Bug đã sửa: widget không hiện trên site CSP chặt** — bản đầu dùng `<style>` tag (chịu `style-src` của TRANG, không phải extension), Chrome âm thầm bỏ qua trên site không có `unsafe-inline`. **Sửa: toàn bộ style qua CSSOM trực tiếp** (`el.style.xxx=`, không phải `<style>`/`style=""` string) — không bị `style-src` chi phối, kỹ thuật chuẩn cho UI extension tiêm vào trang bất kỳ. Đánh đổi: mất `:hover` thật (cần CSS rule) — chấp nhận.
- **`utils/floating-widget.ts`:** `showFloatingWidget` (toast góc trang, update-in-place theo id) + `showAnchoredBadge` (ghim góc phần tử qua `requestAnimationFrame` polling — không dùng scroll/resize listener vì target có thể ở bất kỳ container cuộn nào; tự gỡ khi `target.isConnected===false`, tự ẩn khi rect rỗng; rAF loop tự dừng khi hết badge).
- **Trigger — thiết kế lại sau test thật:** badge gắn video (local, tức thời, không round-trip) là chính; toast góc trang chỉ còn fallback cho case webRequest-only (không có DOM element để anchor, vd MediaSource/blob:). Click badge tải thẳng URL đó; click toast mở Dashboard (không có URL đơn lẻ để tải thẳng).
- **Bug đã sửa: toast's action từng là `<a href="chrome-extension://...">` thật → Chrome chặn** ("This page has been blocked") vì page-context navigation tới extension URL cần nằm trong `web_accessible_resources` (Dashboard cố tình không nằm trong đó — mở rộng sẽ phơi nguyên Management View cho bất kỳ site nào). **Sửa: `onAction` callback + `<button>`**, gửi `chrome.runtime.sendMessage({type:'synapse:open-dashboard', moduleId})` → generic relay trong [background/index.ts](../src/adapters/browser-extension/background/index.ts) gọi `chrome.tabs.create()` (privileged, không bị `web_accessible_resources` chi phối).
- Badge tự nhiên đúng theo từng frame (mỗi frame anchor video của chính nó) — không có vấn đề "N cái chồng nhau".
- **Chưa test bằng browser thật** (agent không có môi trường trình duyệt) — cần verify: badge bám đúng vị trí khi cuộn/resize, tự ẩn/gỡ đúng lúc, toast fallback vẫn hoạt động.

### 4.3. Action-button paradigm — không còn hoãn vô thời hạn, xem mục 6.1

- Rào cản kỹ thuật thật: `action.default_popup` khai tĩnh trong manifest sẽ nuốt trọn click, `chrome.action.onClicked` không bao giờ fire — cần chuyển sang `chrome.action.setPopup({popup:''})` động theo module đang active trước khi bất kỳ module nào được khai paradigm này. Từng coi là Future Adapter treo vô thời hạn; **mục 6.1 giờ là kế hoạch cụ thể để gỡ rào cản này** (dùng `chrome.sidePanel.setPanelBehavior` thay vì `setPopup` động — network-sniffer cần mở Side Panel, không phải một Popup khác theo module).
- `uiParadigm:'action-button'` đã là giá trị hợp lệ trên type (thêm cùng lúc `'float-widget'`) nhưng chưa Module nào dùng — mục 6.1/6.3 là lần gán đầu tiên (network-sniffer).

## 5. Kế hoạch tiếp theo cho `network-sniffer`

Ba hướng — cả 5.1, 5.2, 5.3 đã implement (5.3 phụ thuộc 5.1 xong trước; 5.2 độc lập, làm sau cùng để giảm junk-URL trước khi test lại 5.3 bằng mắt).

### 5.1. Parse manifest HLS (`.m3u8`) — master vs. variant playlist, danh sách resolution — Đã implement

**Bối cảnh:** sau khi 4.1's `stream`-trust fix hoạt động, URL `.m3u8` bắt được có thể là *media/variant* playlist (1 resolution cụ thể, vd "240p") chứ không phải *master* playlist liệt kê mọi resolution — đây chính là thứ Cốc Cốc's UI "3 resolution options" đang hiện. Một manifest (dù master hay variant) cũng không phải là video hoàn chỉnh — chỉ là danh sách segment.

- **Phạm vi cố tình hẹp: chỉ `.m3u8`/HLS, chưa làm `.mpd`/DASH.** DASH cần `DOMParser` (XML) — **service worker không có API này**, mà background (nơi cần chạy để `fetch()` được mọi origin qua `host_permissions` sẵn có) chính là service worker. `.m3u8` là plain text, parse được không cần DOM. Mọi case thật gặp tới nay đều là HLS.
- **Parser thuần mới `shared/media-manifest-parser.ts`** (Global SDK, không I/O, không DOM): `parseM3u8(text, baseUrl): ParsedManifest` — có `#EXT-X-STREAM-INF` → `{kind:'master', variants:{url,resolution?}[]}` (đọc `RESOLUTION=WxH`, resolve URI dòng kế tiếp theo `baseUrl`); có `#EXTINF` (không STREAM-INF) → `{kind:'media', segments:string[], encrypted}` (URL tuyệt đối từng segment, không chỉ đếm — mục 5.3 cần URL thật để tải; `encrypted` = có `#EXT-X-KEY:METHOD=...` khác `NONE`, chính là DRM guard 5.3 dùng); không khớp gì → `{kind:'unknown'}` (graceful).
- **`rowAction` (số ít) → `rowActions` (mảng)** ([ui-schema.ts](../src/kernel/ui-schema.ts)) — `UIRowAction = {kind:'download',label,urlField} | {kind:'trigger',label,op} | {kind:'open-tab',label,urlField,path}` (`'open-tab'` thêm ở mục 5.3, xem bên dưới). `'trigger'` gửi `{op,id}` thẳng tới bus listener của Module — bypass `CollectionCommand`, cùng pattern `report-dom-media`/`report-main-world-media`. `management-view.ts` render theo mảng; `'trigger'` gọi callback mới `onTrigger(op,item)` → `module-data-sources.ts`'s `emitRowActionTrigger(moduleId,op,id)` (mới) → `dashboard/main.ts` wire vào. Không cần reload thủ công — `chrome.storage.onChanged` đã tự refresh Management View.
- **`network-sniffer`'s action "Inspect"** (`rowActions` gồm `download` + `{kind:'trigger', label:'Inspect', op:'inspect'}`, hiện trên mọi dòng — no-op vô hại qua `{kind:'unknown'}` trên URL không phải manifest, không cần cơ chế ẩn/hiện theo điều kiện cho riêng 1 nút này):
  - `run()` xử lý `command?.op==='inspect'`: tra entry theo `id`, `fetch(entry.url)`, `parseM3u8`.
  - `kind:'master'` → `addDetectedMedia` một dòng MỚI mỗi variant (kind `'stream'`, `resolution`, kế thừa `pageUrl` từ entry gốc) — dedupe theo URL sẵn có nên bấm Inspect lại vẫn idempotent. Đây là phần biến 1 manifest mù thành danh sách "N resolution" giống Cốc Cốc.
  - `kind:'media'` → patch tại chỗ `segmentCount` (từ `segments.length`)/`encrypted` vào chính entry đó (cần `updateDetectedMedia(id,patch,cache)` mới trong `store.ts` — hiện chỉ có add/remove). Không lưu chính danh sách URL segment vào storage (xem mục 5.3).
  - Fetch lỗi/`unknown` → no-op im lặng, cùng triết lý `fetch-images`.
  - `DetectedMedia` thêm `resolution?`/`segmentCount?`/`encrypted?` — hiện như field thường trong `uiSchema.fields`, `management-view.ts` không cần sửa gì thêm (giống `thirdParty` ở 4.1).
- **Chưa test bằng browser thật** (agent không có môi trường trình duyệt) — cần verify: Inspect trên master playlist thật ra đúng danh sách resolution, Inspect trên variant playlist patch đúng `segmentCount`/`encrypted`, nút Inspect no-op im lặng trên URL không phải manifest.

### 5.2. Giảm junk-URL vòng 2 — Đã implement

`thirdParty` (mục 4.1) trước đây chỉ là nhãn, không giảm số lượng dòng. Ba hướng rẻ, kết hợp cùng lúc:
- **Domain denylist** ([shared/ad-domain-denylist.ts](../src/shared/ad-domain-denylist.ts), Global SDK, thuần, không dependency) — danh sách nhỏ built-in các ad-network phổ biến (ExoClick, JuicyAds, TrafficJunky, EroAdvertising, PopAds...), cố tình brainstorm-level không exhaustive. `isAdNetworkDomain(url)` so hostname exact hoặc subdomain (`endsWith('.'+domain)`), graceful `false` trên URL hỏng.
- **Path/query keyword heuristic** ([shared/junk-url-patterns.ts](../src/shared/junk-url-patterns.ts), Global SDK, thuần) — `looksLikeAdOrTrackerPath(url)` khớp *toàn bộ* path segment (`/ads/`, `/tracking/`, `/pixel/`...) hoặc *toàn bộ* query key (`ad_id`, `click_id`, `zoneid`...), cố tình không substring-match (tránh `/uploads/` trúng `ads`, `/roadshow/` trúng `ads`). Bù cho denylist tĩnh: bắt được domain mới/domain xoay vòng (DGA-style) chưa kịp thêm vào danh sách, miễn URL còn giữ path/query pattern quen thuộc của ad/tracker.
- **`isJunkUrl` gộp cả hai** ([network-sniffer/index.ts](../src/adapters/browser-extension/background/modules/network-sniffer/index.ts)) — check trước cả branch `resourceType==='media'` trong `classifyDetection` (mấy ad-network này serve `video/*` Content-Type thật, nên check Content-Type ở 4.1 không tự chặn được), áp dụng đồng nhất cả 3 nguồn phát hiện (`webRequest`, `report-dom-media`, `report-main-world-media`), không chỉ nguồn `webRequest`.
- **`defaultHideField` mới trên `UICollectionSchema`** ([ui-schema.ts](../src/kernel/ui-schema.ts), kernel-level generic, không hardcode theo module) — tên field boolean nào đó bị ẩn mặc định trong Management View, kèm checkbox "Show hidden {itemLabel}s" bật lại (không xoá, vẫn filter/dismiss được khi hiện). `network-sniffer` gán `defaultHideField:'thirdParty'`. `management-view.ts`'s `matchesFilter` check field này trước filter text.
- **Verify:** đã chạy pure-function check (`isAdNetworkDomain`/`looksLikeAdOrTrackerPath`/`classifyMediaUrl` qua `tsx`, ngoài repo) xác nhận domain-match/case-insensitive/subdomain/malformed-URL, whole-segment-only path/query match (không trúng `/uploads/`/`/roadshow/`), và domain-mới-vẫn-bắt-được-qua-path — không phải browser test thật.

Chưa làm (dự phòng nếu ba hướng trên chưa đủ sạch): ngưỡng kích thước tối thiểu (`Content-Length`), visibility DOM, setting người dùng tự chỉnh denylist/keyword list, DPI-style payload sniffing (đánh giá là mismatch với mechanism hiện tại — `chrome.webRequest` ở đây headers-only, xem thảo luận trong lịch sử chat), curated blocklist lớn (EasyList/EasyPrivacy/StevenBlack/OISD) qua DNR (đánh giá overkill cho bài toán "bớt junk trong 1 danh sách", cần xác nhận trước như ffmpeg.wasm nếu về sau thật sự cần).

### 5.3. Tải + ghép segment bằng ffmpeg.wasm — Đã implement

Độ lớn ngang mục 1 cộng lại, không phải tính năng nhỏ — vì manifest/variant playlist tự nó không phải video hoàn chỉnh (đúng như Cốc Cốc's UX gợi ý: không cho copy URL nguồn thật vì không tồn tại 1 URL đơn lẻ nào, phải tự tải+ghép rồi mới có file để tải).

- **Dependency nặng** (`@ffmpeg/ffmpeg` + `@ffmpeg/core` + `@ffmpeg/util`, wasm core ~32MB) — ngoại lệ lớn hơn hẳn `turndown`/`@mozilla/readability`, đã xác nhận với user trước khi thêm. Bundle qua npm (không CDN — `@ffmpeg/core?url`/`@ffmpeg/core/wasm?url`, Vite emit thành asset thật dưới `assets/` với content-hash, `assets/*` trong `web_accessible_resources` đã cover sẵn), không dùng kỹ thuật `toBlobURL` các ví dụ chính thức hay dùng (kỹ thuật đó tồn tại để lách CORS khi load từ CDN cross-origin — không cần khi asset đã same-origin với trang extension).
- **Nới CSP MV3:** [manifest.config.ts](../manifest.config.ts) thêm `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` — `WebAssembly.instantiate` bị CSP mặc định của MV3 chặn giống `eval()`.
- **Trang mới [ui/merge/](../src/adapters/browser-extension/ui/merge/)** (Tab riêng qua `chrome.tabs.create`, không phải service worker — ffmpeg.wasm's Worker + WebAssembly cần context trang thật) — đăng ký Rollup input riêng trong [vite.config.ts](../vite.config.ts), cùng kiểu "extra HTML entry" như `dashboard`/`review`. Scope `?url=` (URL manifest), một lần dùng, không có danh sách module riêng — giống `ui/review/`.
- **Mở trang qua rowAction kind mới `'open-tab'`** ([ui-schema.ts](../src/kernel/ui-schema.ts)) — thuần UI như `'download'` (không qua bus/Module's `run()`), `management-view.ts` tự `chrome.tabs.create` tới `path` (trang extension) kèm `item[urlField]` làm query `?url=`. `network-sniffer`'s "Download (merged)" hiện trên mọi dòng không điều kiện — cùng triết lý "no-op/error graceful" như Inspect (mục 5.1), trang Merge tự báo lỗi rõ ràng khi URL không phải media playlist hoặc là master playlist (hướng dẫn Inspect trước).
- **`media-manifest-parser.ts`'s `ParsedManifest`'s `'media'` kind đổi `segmentCount` → `segments: string[]`** (URL tuyệt đối từng segment, không chỉ đếm) — 5.1's Inspect vẫn lưu `segmentCount` vào `DetectedMedia` (từ `segments.length`), nhưng KHÔNG lưu chính danh sách URL (hàng trăm URL/stream, stale ngay khi manifest xoay vòng) — trang Merge tự fetch+parse lại manifest khi user bấm Download (merged), không đọc từ storage.
- **Luồng thật:** click "Download (merged)" → mở Tab `ui/merge/` → fetch+`parseM3u8` lại URL đó → `kind:'unknown'`/`'master'` → thông báo lỗi rõ, không có nút Download. `encrypted:true` → chặn cứng, không có nút Download (không phải try/catch graceful — đây là guard bắt buộc, khác `fetch-images`). Ngược lại: tải tuần tự từng segment (delay ~200ms như `crawlSite`) → lưu tạm qua `blob-store.ts` (IndexedDB, key `merge:<runId>:<i>`) → `ffmpeg.load()` (coreURL/wasmURL trỏ `chrome.runtime.getURL` tới asset bundle sẵn) → từng segment `ffmpeg.writeFile` rồi xoá blob tạm ngay (không giữ hết trong bộ nhớ JS cùng lúc) → concat demuxer (`-f concat -safe 0`, không nối byte thô) + `-c copy` remux thành `output.mp4` → tải xuống qua pattern anchor-click giống Review page.
- **Fetch segment lỗi giữa chừng → dừng hẳn, không skip-and-continue** — khác hẳn `fetch-images`'/`crawlSite`'s per-item skip: thiếu 1 ảnh chỉ làm trang xấu hơn, thiếu 1 segment làm video đứt đoạn. Không có resume — thử lại là chạy lại từ đầu.
- **Chưa test bằng browser thật** (agent không có môi trường trình duyệt) — cần verify: ffmpeg.wasm's Worker thật sự load được `coreURL`/`wasmURL` bundle nội bộ dưới CSP mới (dynamic `import()` một `chrome-extension://` URL bên trong Worker chưa từng verify runtime), remux TS→MP4 ra file phát được, DRM guard chặn đúng lúc, "Download (merged)" trên URL không phải manifest báo lỗi đúng thay vì treo.

## 6. `network-sniffer` UI/UX redesign — Action-button + Side Panel paradigm — chưa implement

**Vấn đề với UX hiện tại (mục 4/5):** quá nhiều thao tác lộ ra cho user không cần biết — "Inspect" là bước kỹ thuật (fetch+parse manifest) bị lộ thành nút riêng; "Download"/"Download (merged)" là hai nút cho cùng một ý định "tôi muốn video này"; Inspect một master playlist tạo ra N dòng mới (một dòng/resolution) trong bảng — user thấy N dòng rời rạc thay vì 1 video với N lựa chọn resolution; bảng (table) trong Dashboard rộng, nhiều cột không liên quan; badge/toast (mục 4.2) mở hẳn Dashboard/Tab mới cho một thao tác lẽ ra nên tại chỗ.

**Mục tiêu UX mới (đã chốt với user):**
- Auto-inspect ngầm — user không thấy nút "Inspect" nữa. `stream`-kind entry tự động được fetch+parse ngay khi phát hiện (hoặc ngay trước khi hiển thị), không chờ click.
- Một action duy nhất: **"Download"**. Bấm vào tự quyết định nhánh (tải thẳng qua `chrome.downloads` cho `video`/`audio`, hay chạy flow merge ffmpeg.wasm cho `stream`), không có nút thứ hai.
- Một video thật = một item trong danh sách, kể cả khi manifest của nó có N resolution — N resolution gộp vào **một `<select>`** trong item đó, không phải N dòng.
- Danh sách hiển thị dạng **list/card**, không phải `<table>` (mục #2's `management-view.ts` là generic renderer dùng chung nhiều module khác — bảng vẫn hợp lý ở đó; network-sniffer cần renderer riêng, xem 6.3).
- Bấm icon **trên toolbar cạnh address bar** (chỗ đặt icon extension chuẩn của Chrome — xem giới hạn kỹ thuật ở 6.1 về vì sao không thể là icon "trong" address bar kiểu Cốc Cốc) mở **Side Panel** — CHỈ khi network-sniffer đang là module được "đưa lên" action button qua radio option mới trong Popup (mục 6.1, đã chốt với user); mặc định (chưa chọn module nào) icon vẫn mở Popup như hiện tại, không đổi hành vi toàn cục ngay khi cài đặt.
- Side Panel = danh sách video + nút "Settings" (gear icon) mở Dashboard. Side Panel **không** có bảng riêng cho download list nữa một khi đã hiện ở đây — Dashboard **thôi hiển thị `DetectedMedia` collection** (không còn Management View table cho module này), chỉ còn giữ vai trò List Modules/toggle active + settings chung (mục 2/2.5) như mọi module khác.

**Thứ tự làm (activate từng paradigm mới ở kernel trước, rồi mới áp dụng vào module) — 3 bước, cộng rủi ro/quyết định mở ở 6.4:**

### 6.1. Activate Action-button paradigm (kernel) — gỡ block đã ghi ở mục 4.3

- Rào cản cũ (mục 4.3): `action.default_popup` khai tĩnh trong manifest nuốt trọn click, `chrome.action.onClicked` không bao giờ fire.
- **Giới hạn kỹ thuật (vẫn đúng, quyết định chốt bên dưới thiết kế xung quanh nó):** action button là **toàn cục cho cả extension**, không phải per-module — Chrome chỉ cho MỘT hành vi click tại một thời điểm (mở Popup tĩnh, HOẶC chạy `onClicked`), không thể vừa mở Popup vừa mở Side Panel tuỳ module đang "active" cùng lúc. Icon "trong address bar" kiểu Cốc Cốc là UI browser-chrome-level của Cốc Cốc, không phải API một extension Chrome chuẩn có quyền tạo — điểm gần nhất đạt được vẫn là action button hiện tại (cạnh puzzle-piece icon).
- **Đã chốt với user — hướng (c): Popup chọn "module nào được lên action button", không đổi hành vi toàn cục mặc định:**
  - **Popup thêm radio option** bên cạnh Slide Toggle activation hiện có của mỗi module (mục 2's Navigation Flow), nhưng CHỈ hiện ở module có `uiParadigm: 'action-button'` — module khác (dedicated-page/float-widget/none) không có gì để "đưa lên" nên không hiện radio. Radio là **mutually exclusive trên toàn Popup** (một nhóm `name` chung xuyên suốt list, không phải theo từng module riêng) — chọn module này tự bỏ chọn module kia, tại một thời điểm chỉ 1 module "sở hữu" action button, đúng giới hạn kỹ thuật ở trên.
  - **Storage mới**, cùng chỗ với `module-registry/storage.ts`'s `isModuleActive` — 1 key đơn (vd `synapse:action-button-module`) giữ id module đang được chọn, hoặc rỗng/absent = "không module nào" (trạng thái mặc định, action button giữ nguyên hành vi Popup như hiện tại).
  - **Background sync khi key đổi** (cùng pattern `pingBusModule`/always-re-register-while-active đã dùng ở mục 4/2.6):
    - Có module được chọn → `chrome.action.setPopup({popup: ''})` (tắt Popup tĩnh để `onClicked` thật sự fire) + `chrome.action.setIcon(...)` theo icon module đó khai + `onClicked` dispatch tới đúng hành vi action-button của module đó (network-sniffer → mở Side Panel, mục 6.3).
    - Không module nào được chọn → khôi phục `chrome.action.setPopup({popup: 'ui/popup/index.html'})` + icon mặc định của Synapse.
  - **Mỗi module đủ điều kiện cần khai thêm icon đại diện — 1 file duy nhất, không phải bộ nhiều size** (`16/32/48/128` như manifest icon truyền thống) — field mới kernel-level trên `Module` (vd `actionIcon?: string`, đường dẫn tới file `.png` — bản `setIcon` thật sự dùng, xem bullet rasterize bên dưới). Vị trí file theo đúng chủ sở hữu: icon dùng chung (global, không thuộc module nào) nằm ở **[src/assets/icon/](../src/assets/icon/)** — đã có sẵn 4 icon Lucide, mỗi icon cả bản nguồn `.svg` lẫn bản dùng được ngay `.png` 24×24: `download`, `rotate-ccw` (refresh), `settings`, `upload`; icon riêng của module cụ thể (nếu không icon global nào phù hợp) nằm trong chính folder module đó (vd `network-sniffer/icon.png`, cạnh `index.ts`/`store.ts`).
  - **Gán icon cụ thể (dùng lại bộ 4 global, chưa cần vẽ mới):** `network-sniffer` được chọn lên action button → `download.png` (khớp đúng action chính, mục 6.3's nút Download duy nhất). Synapse's default action icon (không module nào được chọn, action button mở Popup như hiện tại) → `settings.png`. Side Panel's nút "Settings" mở Dashboard (mục 6.3) → cũng `settings.png`, dùng lại cùng file. `rotate-ccw.png` để dành cho một nút refresh/re-scan trong Side Panel's list nếu cần (chưa quyết có làm hay không). `upload.png` chưa có chỗ dùng trong phase này — dành cho module tương lai.
  - **Rasterize SVG→PNG — đã xong, không còn là việc cần làm lúc code:** `chrome.action.setIcon`/manifest's `action.default_icon` không nhận thẳng `.svg` (chỉ nhận bitmap/`ImageData`), nhưng [src/assets/icon/](../src/assets/icon/) giờ có sẵn cả `.svg` (nguồn) lẫn `.png` (24×24, dùng thẳng cho `setIcon`) cho cả 4 icon — dùng file `.png` khi gọi `setIcon`, không cần build-time/runtime rasterize step nào nữa. Bản thân Synapse hiện **chưa có icon riêng nào khai trong `manifest.config.ts`** (không có `icons`/`action.default_icon`, dùng icon generic của Chrome) — cần khai `settings.png` làm icon mặc định của chính Synapse trong manifest, để có gì "khôi phục về" khi không module nào được chọn.
  - **Edge case phải xử lý:** module đang được chọn mà bị tắt Slide Toggle (active=false) → action button phải tự rơi về Popup mặc định ngay, không kẹt ở icon/click-behavior của module đã tắt (cùng chỗ code xử lý `isModuleActive` check hiện có ở mỗi module's `run()`).
- `uiParadigm: 'action-button'` đã có sẵn trên type (mục 4.3) — chỉ cần Popup's list-view.ts đọc field này để biết module nào đủ điều kiện hiện radio, thay vì mãi là giá trị chưa dùng.

### 6.2. Activate Side Panel paradigm (kernel) — biến định hướng ở mục 7.2 (trước đây 6.2) thành implementation đầu tiên

- `chrome.sidePanel` cần permission mới trong `manifest.config.ts` (`"sidePanel"`) + `side_panel.default_path` hoặc `chrome.sidePanel.setOptions` per-tab.
- Layout dùng lại quy ước `ui/` hiện có (giống `ui/dashboard/`, `ui/merge/` — Rollup input riêng trong `vite.config.ts`, VanJS + Pico.css, không Alpine — mục 2.5), **không phải Shadow DOM** (Side Panel là page thật của extension, không tiêm vào trang khách như mục 4.2's badge/toast).
- Renderer mới `side-panel/list-view.ts` — KHÔNG tái dùng `management-view.ts`'s table renderer (đó là generic CRUD table cho N module khác, ép nó thành list/card sẽ phải nhánh theo module ngay trong code dùng chung — ngược nguyên tắc "generic renderer, per-kind optional callback" của `ui-schema.ts`). Thay vào đó: field mới, kernel-level, tương tự các field khác đã thêm dần ở `ui-schema.ts` (`defaultHideField`, `advanced`, `rowActions`...) — ví dụ `UICollectionSchema.displayAs?: 'table' | 'list'` — nhưng bản thân "list" layout cho network-sniffer đặc thù tới mức (group-by-video, `<select>` resolution) nhiều khả năng cần một schema shape mới hẳn chứ không chỉ đổi `displayAs`; **quyết định chi tiết field/type để lúc thật sự code, không chốt cứng ở plan này.**

### 6.3. Áp dụng vào `network-sniffer`: auto-inspect + gộp resolution + 1 nút Download

- Auto-inspect: `stream`-kind entry tự fetch+parse manifest ngay khi `addDetectedMedia` thêm nó (hoặc lazy — ngay trước khi Side Panel render), không chờ user bấm gì. Giữ nguyên `parseM3u8`/`updateDetectedMedia` (mục 5.1) — chỉ đổi TRIGGER, không đổi logic parse.
- Gộp resolution: thay vì Inspect tạo N `DetectedMedia` mới (một/resolution, hành vi hiện tại của mục 5.1), nhóm N variant vào **một array field trên chính entry gốc** (vd `variants?: {url, resolution}[]`) thay vì N row độc lập — đổi cách `store.ts`/`index.ts`'s `command?.op === 'inspect'` ghi kết quả. Side Panel's item render `<select>` từ `variants`.
- Một nút Download, tự rẽ nhánh theo `kind`/trạng thái entry (video/audio → `chrome.downloads.download` thẳng; stream có `variants` → dùng `<select>` đang chọn; stream `encrypted` → disable nút, báo DRM giống guard hiện tại của mục 5.3) — không còn `rowActions` kiểu `download`/`trigger`/`open-tab` riêng lẻ như `management-view.ts` hiện dùng.
- **Merge flow (mục 5.3) chạy Ở ĐÂU:** Side Panel tự nó là page thật (không phải service worker) — về lý thuyết ffmpeg.wasm's Worker+WebAssembly chạy được ngay trong Side Panel, không bắt buộc phải mở Tab `ui/merge/` riêng như hiện tại nữa (khớp đúng ý "mở side bar thay vì mở trang mới" của user). Cần xác nhận runtime thật (agent không có browser) trước khi coi đây là quyết định cuối — nếu Side Panel's process có giới hạn không chạy nổi ffmpeg.wasm, giữ nguyên Tab `ui/merge/` làm fallback nhưng bấm Download trong Side Panel tự mở Tab đó thay vì user tự bấm "Download (merged)" như bây giờ.
- Dashboard: bỏ `listCollection`/Management View khỏi entry của module này (hoặc giữ field nhưng Dashboard route thẳng qua Side Panel thay vì tự render) — cần xem lại `chrome-module-registry.ts`/`dashboard/main.ts`'s routing logic (mục 2/2.5) để biết cách tắt Management View cho riêng 1 module mà không phá vỡ module khác.

### 6.4. Chưa quyết / rủi ro cần đo trước khi code

- **Icon asset đã có sẵn, kể cả bản PNG** ([src/assets/icon/](../src/assets/icon/), 4 icon Lucide `download`/`rotate-ccw`/`settings`/`upload`, mỗi icon có cả `.svg` nguồn và `.png` 24×24 dùng thẳng cho `setIcon`) — không còn việc thiết kế/chọn icon hay rasterize nào cần làm trước khi code 6.1 nữa, chỉ còn việc khai báo (field `actionIcon` trỏ đúng file `.png`, gán `settings.png` làm default trong `manifest.config.ts`).
- ffmpeg.wasm chạy trong Side Panel context chưa từng verify (6.3).
- Side Panel do Chrome quản lý per-window (không phải per-tab mặc định) — cần kiểm tra hành vi khi user chuyển tab/window có ảnh hưởng gì tới danh sách đang hiện không (khác hẳn Popup's vòng đời "đóng khi mất focus").
- Chỉ 1 module (`network-sniffer`) đủ điều kiện `uiParadigm:'action-button'` hiện tại, nên radio group ở 6.1 mới có 2 trạng thái thực tế ("network-sniffer" / "không module nào") — cần nhớ lại thiết kế mutually-exclusive khi có module thứ 2 dùng paradigm này về sau, tránh vá tạm theo kiểu hardcode 1 module.

## 7. Rà soát vị trí UI theo khung nguyên tắc Popup/Dashboard/In-page/Side Panel — chưa implement

Đối chiếu UI hiện có với khung quyết định ở skill [`ui-surface-placement`](../.claude/skills/ui-surface-placement/SKILL.md) (Popup=tương tác <10s/toggle toàn cục, Dashboard=New Tab cho CRUD/tác vụ dài, In-page Shadow-DOM=hành động gắn 1 phần tử cụ thể, Side Panel=tương tác nhiều lượt song song trang — bề mặt Synapse chưa dùng). Chỉ ghi nhận điểm lệch, không sửa code trong đợt rà soát này.

### 7.1. Crawl & Convert Site's progress đang sống trong Popup — lệch nguyên tắc "Popup chỉ cho tương tác <10s"

- **Vấn đề:** action Crawl (mục 1) chạy tuần tự tới `MAX_CRAWL_PAGES=200`, delay ~200ms/trang — tổng thời gian dễ vượt xa vòng đời Popup (đóng ngay khi click ra ngoài trang). Trade-off "đóng popup giữa chừng lúc crawl mất kết quả" đã ghi ở mục 1 chính là hệ quả trực tiếp của việc đặt sai bề mặt UI, không phải bug cô lập.
- **Hai hướng refactor, chưa chọn (cần đo thời gian crawl thật trước khi quyết):**
  - (a) Bấm Crawl ở popup → mở ngay Dashboard/Tab hiển thị progress trực tiếp, popup tự đóng ngay sau khi trigger.
  - (b) Giữ trigger ở popup, nhưng progress/result chạy hẳn ở nền + `chrome.notifications` báo hoàn tất; mở lại Dashboard là thấy kết quả sẵn — không cần giữ tab mở suốt.
- Reader Mode Converter (đơn trang, không crawl) không có vấn đề này — 1 lần fetch thường dưới ngưỡng 10s, Popup vẫn hợp lệ.

### 7.2. Side Panel — bề mặt chưa từng dùng khi mục này được viết, nay là target của mục 6

- Chưa module nào dùng `chrome.sidePanel` **tính tới trước mục 6** — mục 6 ở trên giờ là ca dùng cụ thể đầu tiên (network-sniffer), không còn là định hướng chờ nhu cầu nữa.
- Định hướng gốc vẫn đúng cho nhu cầu KHÁC: nếu về sau có Module `needs:['ai']` cần tương tác nhiều lượt gắn với 1 tab (chat hỏi-đáp về trang đang xem, dịch đoạn dài, ghi chú đối chiếu — đúng hình dạng `PersonaAutomationAgent` ở design.md §6), vẫn ưu tiên Side Panel thay vì Dashboard/Popup, dùng chung cơ chế kernel mục 6.2 dựng lên thay vì viết lại.
- Không sửa `docs/design.md` §7 cho tới khi mục 6 thật sự implement (Side Panel chưa phải Execution Context đã implement, chỉ đang ở plan).

### 7.3. Các bề mặt đã khớp nguyên tắc, không cần đổi

Popup cho Module Registry list/toggle + action ngắn; Dashboard cho Management View/Steps view/Review-ZIP; Shadow DOM badge+toast (`network-sniffer`, mục 4.2, đã tự áp dụng zero-intrusion + CSSOM-not-`<style>` trước khi khung nguyên tắc này được viết ra) — **sẽ đổi hành vi click khi mục 6 implement** (badge/toast vẫn đúng chỗ để BÁO có media mới, nhưng nút Download bên trong chuyển sang mở Side Panel thay vì `chrome.downloads.download`/mở Dashboard thẳng, xem mục 6.3); Action-button paradigm không còn "hoãn" nữa — mục 6.1 là kế hoạch activate nó, thay vì chờ vô thời hạn như mục 4.3 từng ghi.
