# Changelog

Mọi thứ **đã ship** — what shipped + where (file path) + bug thật phát hiện qua test và cách vá. Tách khỏi [ROADMAP.md](ROADMAP.md) vì đây là quá khứ: ROADMAP chỉ nhìn về hiện tại và tương lai.

Sắp theo khu vực tính năng (số mục là định danh ổn định, được Open Points của ROADMAP tham chiếu tới — đừng đánh số lại). Bài học kỹ thuật tổng quát hoá được nằm ở [LESSONS.md](LESSONS.md); quyết định kiến trúc nằm ở [design.md](design.md). Mục ở đây trả lời "cái gì tồn tại, ở đâu, và đã sập kiểu gì".

---

## 1. Reader Mode Converter

Composite Module 4 bước (`load-dom` → `clean` → `fetch-images` → `convert-markdown`, qua `createCompositeModule`) + action Crawl site + Review/ZIP page.

- **`HtmlToMarkdownConverter`** ([shared/html-to-markdown.ts](../src/shared/html-to-markdown.ts)) wrap **Turndown**, 2 rule tuỳ biến resolve `src`/`href` tương đối→tuyệt đối. `clean` dùng **`@mozilla/readability`**. `fetch-images` fetch trực tiếp trong content-script, cap ~10MB/ảnh, dedupe theo URL.
- **Crawl & Convert Site**: discovery qua `robots.txt`/`sitemap.xml`/nav-expand; same-origin, `MAX_CRAWL_PAGES=200`; `fetch()`+`DOMParser` (không phải `chrome.tabs` navigate) để tái dùng nguyên pipeline; output file-per-page qua `pathFromUrl`+`slugify()`.
- **Review page + ZIP**: Tab riêng, handoff qua `review-handoff.ts` (ảnh→IndexedDB `blob-store.ts`, text nhỏ→`chrome.storage.session`). ZIP tự viết ([shared/zip.ts](../src/shared/zip.ts), không dependency).
- `UIActionSchema` tổng quát hoá thành mảng `actions[]` ([ui-schema.ts](../src/kernel/ui-schema.ts)).

## 2. Module Registry UI

- Declarative UI Schema ([kernel/ui-schema.ts](../src/kernel/ui-schema.ts)): `UISchema = UICollectionSchema | UIActionSchema`. `chrome-module-registry.ts` gộp `BUNDLED_MODULES`+`BACKGROUND_MODULES`.
- Popup: list module + Slide Toggle; module có Setting mở Management View, module chỉ-Action trigger thẳng `run()`. Không dùng `<dialog>` trong popup (xem [LESSONS.md](LESSONS.md)) — toàn bộ popup là in-flow view-swap qua `router.ts`.

### 2.5. Trang Quản lý Nội bộ Độc lập (Dashboard)

VanJS (không phải Alpine.js — MV3 CSP chặn `unsafe-eval` mà Alpine cần) + Pico.css.

- Layout dùng chung [ui/](../src/adapters/browser-extension/ui/): `ui/popup/` + `ui/dashboard/` + [module-data-sources.ts](../src/adapters/browser-extension/ui/module-data-sources.ts).
- Popup chỉ `chrome.tabs.create` mở Dashboard rồi tự đóng. Mỗi module tự sở hữu `chrome.storage.local`; `listCollection()` sống trên chính Module.
- Extra HTML entry khai tay trong [vite.config.ts](../vite.config.ts) — xem [LESSONS.md](LESSONS.md).

### 2.6 + 2.6.1. Nâng cấp Network Interceptor (`http-error-mocker`)

3 mechanism song song qua field `mechanism` ([shared/http-mock.ts](../src/shared/http-mock.ts)), 1 shape `MockConfig` chung:

- **`main-world`:** rẻ nhất, không banner, chỉ mock fetch/XHR.
- **`debugger`:** CDP `Fetch.enable`/`fulfillRequest`/`continueRequest` — hiện đúng Network tab, bắt mọi loại request, nhưng Chrome hiện banner "đang debug tab" liên tục.
- **`dnr`:** declarativeNetRequest, không banner, thuần khai báo — `block`/`rewrite-request`/`fake-response` (redirect sang `data:` URL). Rule ID băm FNV-1a từ `MockConfig.id`.
- File tĩnh đóng gói sẵn ([mock-files/](../src/adapters/browser-extension/features/http-mock/mock-files)), enumerate build-time qua `import.meta.glob`. Fake file qua upload: `debugger`→IndexedDB; `main-world`→inline base64 (cap 2MB).
- **§2.6.1 `rewriteBody` qua file upload** — `rewriteBodyFile`/`rewriteBodyFileInline`/`rewriteBodyFileName`, cùng khuôn `fakeResponseFile*`. `RewriteOverrides`/`InterceptRewriteOverrides` thêm `bodyEncoding?: 'utf8'|'base64'`.
- Kernel-level mới: `showWhen` dạng mảng AND, `UIFieldDef.suggestions`/`advanced`, `type:'file'` field.

### 2.6.2. Bug thật qua `http-mock-test-page.cjs` — đã xác nhận bằng browser thật

Trang test ([docs/examples/http-mock-test-page.cjs](examples/http-mock-test-page.cjs)) phủ đủ tổ hợp mechanism×action — cũng là lượt verify-bằng-Chrome-thật đầu tiên cho `http-mock` sau refactor `features/` (§11.5). 5 bug thật, tất cả đã vá và user xác nhận:

1. **`main-world`'s rewrite-request: GET/HEAD kèm body sống sót từ request gốc.** `patchFetch` spread `...init` TRƯỚC khi override method; rule đổi method (POST→GET) nhưng để lại body cũ → `fetch(url,{method:'GET',body:<cũ>})` throw `TypeError`. Vá: tính `effectiveMethod`, OMIT hẳn `body` khi effective method là GET/HEAD (không set `undefined` — file bật `exactOptionalPropertyTypes`).
2. **`debugger`'s rewrite-request: CDP `Fetch.continueRequest.headers` THAY THẾ toàn bộ header, không merge** (xem [LESSONS.md](LESSONS.md)). Vá: đọc header gốc từ `Fetch.requestPaused` event, merge với override trước khi gửi.
3. **`delayMs` cho `mechanism:'dnr'` im lặng bị bỏ qua** — DNR thuần declarative, không delay được. Vá: ẩn field qua `showWhen`.
4. **Mọi `CollectionCommand` (upsert/delete) fire-and-forget — chưa từng surface lỗi validate cho UI.** Rule bị `validateMockConfig` từ chối vẫn lưu "thành công" im lặng. Vá toàn tuyến, generic cho mọi collection-schema Module: `BusService.on`'s handler trả `Promise`; `chromeRuntimeBus` await rồi trả `sendResponse({ok,error?})`; `Scheduler.registerOnBus` re-throw sau khi log; `emitCollectionCommand` await response thật; `item-form-view.ts` thêm banner lỗi inline, ở lại form khi lỗi.
5. **`dnr-network-rules.ts`'s `ruleIdsFor` — lỗi toán học, xác suất 50%.** `base = hash % (RANGE_SIZE-4)` rồi `*2+offset` — phép nhân đôi không tính vào modulo, 50% id tràn khỏi range khai báo → rule mồ côi vĩnh viễn (bộ lọc dọn dẹp không bao giờ thấy các id này). Vá: modulus đổi thành `Math.floor((RANGE_SIZE-3)/2)`; verify lại bằng 1 triệu UUID ngẫu nhiên: 0 overflow.

2 bug trong chính trang test (không phải extension): (a) response echo chỉ hardcode 2 header, khiến rule thêm header mới trông như không chạy — sửa echo lại toàn bộ `req.headers`. (b) nút GET dùng URL tĩnh không cache-bust — thêm `bust()` helper + `cache:'no-store'`. (c) `btoa(String.fromCharCode(...bytes))` throw `RangeError` với ảnh đủ lớn — đổi sang `Blob`+`URL.createObjectURL`.

## 3. Module Chain (Composite Module) — chỉ bản tuần tự

- [kernel/composite-module.ts](../src/kernel/composite-module.ts)'s `createCompositeModule` — không rollback (sub-module throw bị bắt per-step, `onSubFailure`, value giữ nguyên trôi sang bước kế). Không Context Share mutable.
- `RegistryEntry` thêm `subModules`/`subState`. UI sub-toggle ở Dashboard's Steps view — **chỉ đúng cho Composite Module BUNDLED**; §12.3 đổi hướng cho script UPLOAD (sidebar chuyển vào Studio).
- Case nghiệp vụ thật đầu tiên: `reader-mode-converter` (§1).

## 4. Generic Network Sniffer / Shadow DOM popover

Business case: phát hiện URL video/audio/stream trang tự request, liệt kê, cho tải về.

- **Phát hiện qua 3 nguồn:** (a) `chrome.webRequest.onHeadersReceived` ([webrequest-media-observer.background.ts](../src/adapters/browser-extension/features/media/webrequest-media-observer.background.ts)) + `shared/media-url-matcher.ts`; (b) DOM sniffing (`<video>`/`<audio>` đã render); (c) MAIN-world observe-only interceptor cho player MSE (`blob:`).
- **Trust split chống junk-URL:** `resourceType==='media'` tin Content-Type trước/URL-extension fallback; nhánh ồn bắt buộc Content-Type khớp thật, trừ đuôi `.m3u8`/`.mpd`.
- **Phủ iframe nested/cross-origin:** content-script riêng `all_frames:true` ([frame-media-observer.content.ts](../src/adapters/browser-extension/features/media/frame-media-observer.content.ts)); Module `iframe-unsandbox` riêng (mặc định OFF).
- **Shadow DOM popover** — `utils/floating-widget.ts` (nay đã XOÁ, thay bởi `ui-compositor.ts` ở §11.4, xem [design.md §10](design.md#10-ui-compositor--shadow-dom-surfaces-for-scripts-synapseapiui)).
- `uiParadigm` field (`'none'|'dedicated-page'|'float-widget'|'action-button'`).

## 5. `network-sniffer` — parse manifest, giảm junk, tải+ghép

- **5.1 Parse `.m3u8` (HLS):** `shared/media-manifest-parser.ts`'s `parseM3u8` — phân biệt master vs media playlist. Cố tình chưa làm DASH/`.mpd` (service worker không có `DOMParser`).
- **5.2 Giảm junk-URL:** domain denylist ([shared/ad-domain-denylist.ts](../src/shared/ad-domain-denylist.ts)), path/query keyword heuristic ([shared/junk-url-patterns.ts](../src/shared/junk-url-patterns.ts)), `defaultHideField` kernel-level.
- **5.3 Tải + ghép bằng ffmpeg.wasm** — trang Merge ban đầu (Tab riêng) **đã bị xoá hẳn ở §8.1**; engine chuyển sang Offscreen Document.

## 6. `network-sniffer` UI/UX — Floating icon + Side Panel

- **6.1** `showFloatingIcon`/`dismissFloatingIcon` — chỉ 2 trạng thái ẩn/hiện.
- **6.2** Side Panel qua manifest field `side_panel` — xem [LESSONS.md](LESSONS.md) cho gotcha `sidePanel.open()`.
- **6.3** `DetectedMedia` thêm `variants?`; auto-inspect ngầm ngay sau `addDetectedMedia`. Side Panel (`ui/side-panel/`, VanJS riêng) scope theo trang chính xác đang xem.
- **6.5–6.8** filter junk-URL áp cả lên `pageUrl`/initiator + `looksLikeAdMacroTemplate`; Side Panel card redesign; Side Panel tự tắt khi tab active là Dashboard; Dashboard gộp `download`+`open-tab` thành `UIRowAction` kiểu `'smart-download'`.

## 7. Sniffing & Detector — bổ sung theo checklist (7.1–7.6)

- **7.1 Bắt & replay Request Headers** — `onSendHeaders`+`extraHeaders` ([webrequest-media-observer.background.ts](../src/adapters/browser-extension/features/media/webrequest-media-observer.background.ts)); replay qua DNR session rule ([header-replay-rules.ts](../src/adapters/browser-extension/features/media/header-replay-rules.ts)), KHÔNG lưu Cookie/Authorization. **Đã xác nhận bằng browser thật.**
- **7.2 Magic bytes / payload sniffing** — `shared/media-magic-bytes.ts`'s `sniffMediaMagicBytes`. Probe chủ động `Range: bytes=0-1023` chỉ khi thực sự mù.
- **7.3 Correlation MSE** — hook `URL.createObjectURL`/`MediaSource.addSourceBuffer`, hook `window.Hls` global, `document.addEventListener('play', ..., true)`.
- **7.4 URL ký/hết hạn** — `shared/signed-url-detector.ts`'s `looksLikeSignedUrl`. Tự phục hồi 401/403 giữa lượt tải (chỉ VOD, ngân sách 1 lần/lượt).
- **7.5 Ad-filter mở rộng** — path segment (`vast`/`vpaid`/`ima`/...) + `looksLikeAdHostnamePrefix`.
- **7.6 Download UX nền** — đã thay thế hoàn toàn bởi Offscreen Document engine ở §8.1.

### 7.3(a-hls). Bug thật — 3 vòng vá, VẤN ĐỀ VẪN CÒN

3 bug phát hiện qua browser thật, đã vá — **nhưng badge vẫn KHÔNG ổn định sau cả 3 lần** (Open Point `[§7.3-open]` trong [ROADMAP.md](ROADMAP.md)):

1. `wrap()`'s `MANIFEST_LOADED` handler chỉ check `this.media` ĐÚNG lúc event bắn — trang gọi `hls.loadSource(url)` TRƯỚC `hls.attachMedia(video)` (thứ tự hợp lệ của hls.js) khiến `this.media` còn `null`, event bị bỏ qua VĨNH VIỄN. Vá: nghe thêm `Hls.Events.MEDIA_ATTACHED`, bắn callback khi cả hai sẵn sàng bất kể thứ tự.
2. `setAttribute()` (MAIN world) không kích hoạt rescan phía ISOLATED world — `MutationObserver` chỉ có `attributeFilter: ['src']`. Vá: channel mới `MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID`, MAIN world bắn tín hiệu rescan tường minh.
3. Bug do CHÍNH bản vá (1) để lại: `tryFire()` có latch `fired` một-lần-duy-nhất mỗi Hls instance — trang tái dùng CÙNG 1 instance cho nhiều video kế tiếp khiến video thứ hai trở đi bị bỏ qua, badge kẹt ở URL cũ. Vá: bỏ hẳn latch `fired`.

Sau cả 3 lần vá, user xác nhận vấn đề badge/anchor VẪN Y NGUYÊN — cả ba bug đều thật (đọc code hợp lý) nhưng không phải nguyên nhân gốc, hoặc còn nguyên nhân thứ 4 chưa tìm ra. **Bài học: dừng vá theo giả thuyết đọc-code, cần debug trực tiếp trên trang thật.**

## 8. Downloader Engine (8.1–8.12)

Đối chiếu checklist "Web Worker Downloader Engine": đủ — parse manifest, staging OPFS, pool song song + retry/backoff, giải mã AES-128, remux qua `ffmpeg.mount(WORKERFS)`, fallback `.ts` khi vượt ngưỡng, chạy trong Offscreen Document, export qua Blob+`chrome.downloads`, multi-connection Range downloader opt-in.

- **8.1** Port sang `utils/download-engine.ts` (nay da tach, xem §11.2), chạy headless trong Offscreen Document singleton (`utils/offscreen-manager.ts`). Protocol: [`shared/download-engine-protocol.ts`](../src/shared/download-engine-protocol.ts). Background chỉ là relay (xem [LESSONS.md](LESSONS.md)).
- **8.2** Multi-connection Range downloader — opt-in "Turbo download", mặc định OFF, `START_TURBO`, ghi OPFS theo offset, `MIN_TURBO_SIZE_BYTES=5MiB`.
- **8.3** Pool song song `SEGMENT_POOL_SIZE=5` — `pendingWrites`/`flushReady()` giữ đúng thứ tự ghi; retry tối đa 3 lần.
- **8.4** Giải mã AES-128 per-segment — phân biệt AES-128 (giải mã được) vs SAMPLE-AES/DRM thật (chặn cứng, xem [LESSONS.md](LESSONS.md)).
- **8.5** OPFS thay IndexedDB (sửa OOM thật — xem [LESSONS.md](LESSONS.md)); `REMUX_SIZE_CAP_BYTES=2GB` vượt ngưỡng tự động fallback `.ts`.
- **8.6–8.11 bugfix từ test thật, đã áp vào baseline:** `chrome.sidePanel.open()`/DNR gotcha; relay tự gửi trùng message cùng type → `OPFS InvalidStateError` (tách `DownloadEngineRelayedCommand` khỏi type client-facing); VanJS `render()` không diff DOM → nhấp nháy/rớt click (`scheduleRender()` coalesce qua rAF); `inFlight` phải đếm theo trọn vòng đời item chứ không theo attempt (race khiến `'paused'` bị `'segments'` đến sau đè lại); `sweepStaleOpfsRuns()` dọn file mồ côi khi Offscreen Document khởi động; Offscreen Document chỉ dùng được `chrome.runtime` — relay qua background, một listener cũ thiếu type-guard từng giành mất response. Chi tiết đầy đủ ở [LESSONS.md](LESSONS.md).

### 8.12. Persist + resume download job sau khi bị ngắt — chỉ HLS, đã xác nhận bằng browser thật

- **`DownloadJobCheckpoint`** + op `'RESUME_CHECKPOINT'` (khác `'RESUME'`, vốn chỉ un-pause job còn sống trong bộ nhớ) — Side Panel tự cầm sẵn checkpoint object và gửi nguyên nó kèm lệnh. [`download/checkpoints.ts`](../src/adapters/browser-extension/features/media/download/checkpoints.ts) CRUD `chrome.storage.local` thuần.
- Checkpoint ghi định kỳ (`CHECKPOINT_INTERVAL_MS=20000`, coalesce theo thời gian không phải mỗi segment).
- **Bug thật ở lượt test crash-and-resume đầu tiên, resume fail 100%: `bytesWritten()` không có nghĩa gì nếu chưa `commit()`.** `FileSystemWritableFileStream.write()` chỉ ghi vào swap file riêng, không byte nào durable tới khi `close()` — `OpfsRun` sống suốt cả job nên chưa từng close, checkpoint cũ hoàn toàn không phản ánh thực tế trên đĩa. Vá: **`OpfsRun.commit()`** đóng rồi mở lại writable qua `createWritable({keepExistingData:true})` ngay trước mỗi lần lưu checkpoint, bắt buộc `await` trong cùng `writeChain`. Đây cũng là lý do interval phải giãn từ 3s lên 20s — `keepExistingData:true` copy lại TOÀN BỘ file hiện có, chi phí O(kích thước file). Xem [LESSONS.md](LESSONS.md#persist-and-resume-state-across-a-killed-context-812).
- Sau vá: reload extension giữa lượt tải thật rồi Resume → thành công, file phát được. Xác nhận luôn rằng `createWritable({keepExistingData:true})` trên file có writable phiên trước chưa đóng KHÔNG đụng khoá cấp thấp như từng lo ngại.
- Resume KHÔNG tin checkpoint mù: refetch+reparse manifest, từ chối nếu live/DRM/segment ít hơn checkpoint; `tryResumeOpfsRun` so `file.size` thật, `truncate()` về đúng offset. Mọi nhánh từ chối đều `emit('error')` kèm lý do + tự dọn checkpoint.
- `sweepStaleOpfsRuns()` nhận thêm `keepRunIds` — nếu không, sweep sẽ xoá đúng file mà resume cần đọc, ngay TRƯỚC KHI lệnh RESUME_CHECKPOINT có cơ hội tới.
- Chỉ HLS, không turbo. Checkpoint xoá ở mọi trạng thái cuối (done/error/cancelled).

## 9. Rà soát UI Surface Placement

Đối chiếu khung [`ui-surface-placement`](../.claude/skills/ui-surface-placement/SKILL.md) — Side Panel là ca dùng đầu tiên (§6), các bề mặt còn lại đã khớp: Popup (Module Registry), Dashboard (Management/Steps/Review-ZIP), Shadow DOM (badge/toast/icon nổi).

### 9.1. Reader Mode Converter's trigger — Popup → in-page icon + Side Panel + Review tab

Bản đầu (bấm Crawl trong Popup → mở ngay Review tab) sai nguyên tắc — mở Tab ngay lập tức hất người dùng khỏi trang đang đọc, đẩy chính tab đang crawl xuống nền đúng lúc Chrome dễ throttle nhất.

- **Trigger dời hẳn vào trang** — 2 icon nổi "Convert this page"/"Crawl this site" ([content-scripts/index.ts](../src/adapters/browser-extension/content-scripts/index.ts)). `reader-mode-converter.module.ts` bỏ hẳn `uiSchema`, thêm `uiParadigm: 'float-widget'`.
- **Chạy `run()` tại chỗ** — trigger và thực thi cùng context. Icon click gửi `synapse:open-side-panel` ĐỒNG BỘ trước (giữ user-gesture cho `chrome.sidePanel.open()`), rồi mới `await mod.run(...)`.
- Side Panel thêm khu vực "Reader Mode" ([ui/side-panel/main.ts](../src/adapters/browser-extension/ui/side-panel/main.ts)). Tách nhỏ dùng chung: `ui/review-zip.ts`, `ui/review-path.ts`.
- **2 bug thật qua browser thật, đã vá:** (a) panel lẫn lộn Media Sniffer/Reader Mode — cả 2 khối trong 1 list không nhãn, header ghi cứng "Media Sniffer". Vá: `renderSectionHeader()` dùng chung, h1 top-level đổi thành "Synapse". (b) progress bar không chạy — `progressTag()` gọi không `value`/`max` (indeterminate) dù đã có `done`/`total` thật; Pico.css không animate indeterminate `<progress>`. Vá tận gốc: `listenForActionProgress` trả `{message, done, total}` thay vì chỉ `message` string đã format sẵn.

## 10. Live capture & tabUrl

### 10.1. Live/continuous HLS stream capture

Giả định cũ của Downloader Engine (§8) sai gốc cho live/LL-HLS. Quyết định: dừng khi `#EXT-X-ENDLIST` xuất hiện TỰ NHIÊN HOẶC user bấm Stop; remux chỉ 1 lần ở cuối, giống VOD.

- `parseM3u8` thêm `targetDurationSec` để canh nhịp poll (fallback `LIVE_POLL_FALLBACK_MS=5000`).
- **`runLiveJob`** — vòng lặp TUẦN TỰ, không phải pool (segment live tới từng cái một, không có backlog để song song). Định danh segment qua **media-sequence tuyệt đối**, không phải index mảng (cửa sổ trượt khiến index không còn trỏ đúng segment cũ).
- `fetchAndDecryptSegment`/`fetchInitSegmentBytes` tách ra dùng chung giữa VOD pool và live loop — khác nhau ở NGƯỜI GỌI quyết định thất bại-sau-retry nghĩa là gì (VOD huỷ cả job; live log cảnh báo rồi bỏ qua).
- Dừng qua `STOP_LIVE` hoặc `#EXT-X-ENDLIST` — cả 2 chỉ set `JobControl.liveStopRequested`, rơi vào ĐÚNG đường finish của VOD.
- **Cố ý KHÔNG checkpoint/resume-sau-crash cho live** (chi phí O(kích thước file) của `commit()` sẽ tăng vô hạn trên file không có kích thước cuối).

### 10.4. `tabUrl` cho cả `report-dom-media`/`report-main-world-media`

Trước đây `tabUrl` chỉ tính được cho nguồn `webRequest` — media trong iframe cross-origin bị ẩn khỏi Side Panel dù đã lưu đúng.

- Dời 2 op ra khỏi `run()`'s Bus dispatch, sang 2 listener `chrome.runtime.onMessage` sender-aware độc lập — `BusService.on()`'s handler shape không có `sender`, mà `sender.tab.url` chính là thứ cần đọc. Gộp TOÀN BỘ xử lý vào ĐÚNG 1 listener mỗi op để tránh race giữa 2 listener cùng nghe 1 message.
- **`persistDetectedMedia(url, pageUrl, tabUrl, cache)`** gộp logic trùng lặp.
- **Đã đổi hướng scope (user xác nhận HOẠT ĐỘNG TỐT):** Side Panel đổi từ scope-theo-**origin** sang scope-theo-**trang chính xác** — scope-theo-origin khiến list "luôn dồn thêm link của mọi trang, rất lộn xộn". Đánh đổi đã chấp nhận: SPA đổi route không kèm navigation thật có thể ẩn 1 entry vừa phát hiện.

---

## 11. Pivot: Userscript Platform — Phase 0→5

Định vị lại sản phẩm: Synapse là **một bản nâng cấp của Tampermonkey**. User script thành công dân hạng nhất; module builtin tụt xuống vai trò reference implementation. Quyết định kiến trúc đầy đủ ở [design.md](design.md) §3.D/E, §8, §10–13.

### 11.1 Phase 0 — Nền

vitest tách riêng khỏi build MV3 ([vitest.config.ts](../vitest.config.ts) — để vitest fallback vào `vite.config.ts` là chạy nguyên build MV3 mỗi lần `npm test`). 74 test cho `src/shared/`; 20 test kernel thay 2 smoke-test demo (`append-a`/`append-b`/`demo-composite` xoá hẳn — trước đây chạy + `console.log` trong MỌI bản build). Adapter thứ 2 khai tử ở mức code (`RuntimeEnv`/`RUNTIME_ENVS`/`Module.supportedEnvs`/`environment-guard.ts` xoá hẳn — xem [design.md §8](design.md#8-a-second-runtime-adapter--considered-and-rejected)). `workflowId` dispatch xoá (0 caller); `kernel/workflow.ts` GIỮ.

### 11.2 Phase 1 — Tách `download-engine.ts` (1.355 dòng) — đã xác nhận bằng browser thật

Refactor thuần cấu trúc, không đổi hành vi runtime nào (mọi message type, chuỗi lỗi, hằng số giữ nguyên giá trị).

- **→ [`src/shared/download/`](../src/shared/download/)** (8 module thuần + 8 file test, +61 test): `ordered-writes`, `byte-ranges`, `retry`, `checkpoint`, `hls-crypto`, `hls-segments`, `output-naming`, `progress`.
- **→ [`features/media/download/`](../src/adapters/browser-extension/features/media/download/)** (11 file): `engine`, `job-control`, `segment-pipeline`, `vod-job`/`live-job`/`turbo-job`, `output`, `segment-fetcher`, `background-relay`, `engine-events`, `checkpoints`.
- `runJob` (~300 dòng) tách làm 3. `SegmentPipeline` gom trọn phía GHI — trước là 6 closure sửa state của nhau theo thứ tự không có gì đảm bảo.
- Quy ước hậu tố `.offscreen.ts` áp dụng sớm ngay tại đây (xem [design.md §11](design.md#11-features--directory-axis--context-suffix-convention)). `utils/` co từ 3.284 xuống 1.894 dòng.

### 11.3 Phase 2 — `synapseApi` + scope permission ← KEYSTONE — đã xác nhận bằng browser thật

`src/kernel/synapse-api.ts` (TYPE-ONLY + IMPORT-FREE có chủ đích — `userscript-dts.ts` copy nguyên văn vào `.d.ts` công bố) + `src/kernel/scopes.ts` (phần DATA). Catalog v1 CỐ Ý nhỏ: `storage.rw` (Enforced) + `page.dom`/`page.fetch` (Disclosed) — `bus`/`cache`/`ai` XOÁ khỏi bề mặt user script tại đây. 3 transport 1 implementation qua `createSynapseApi(moduleId)`. `rpc-handler.ts` enforce theo scope, fail-closed. Migration grant: bản dạng cũ (`Capability[]`) bị DROP, không map. Consent UI tách 2 danh sách Enforced/Disclosed. `docs/types/synapse-userscript.d.ts` giờ SINH RA từ catalog. Xem [design.md §3.E](design.md#e-synapseapi-and-the-scope-model-the-public-contract).

**3 bug thật, tất cả có TỪ TRƯỚC Phase 2, phát hiện ở lượt verify browser thật đầu tiên:**

1. **`globalThis.synapseApi` — 1 world, nhiều script cùng gán, script evaluate SAU CÙNG chiếm tên.** Mỗi script khác gọi qua global sẽ gửi RPC mang `moduleId` + grant của script đó. Đúng lớp lỗi "định danh đến từ môi trường ambient thay vì từ transport" mà cả mô hình scope dựng ra để diệt, và chỉ lộ khi có script thứ 2 — tức thứ Phase 2 vừa mở khoá. Vá: API tới script qua `ctx.api`, tên `synapseApi` giữ 1 stub reject kèm giải thích.
2. **Message của user script đi vào `chrome.runtime.onUserScriptMessage`, KHÔNG phải `onMessage`.** `rpc-handler` chỉ đăng ký `onMessage` → mọi lời gọi fail *"Could not establish connection"*, và cùng lỗi đó nuốt luôn `synapse:manifest-report` (script không khai được `scopes`, popup không có nút Grant). Một nguyên nhân, hai triệu chứng trông rời rạc. Vá: đăng ký cùng listener lên cả hai event, `try/catch` riêng cho `onUserScriptMessage` (event này có thể không tồn tại khi "Allow User Scripts" tắt — throw ở top-level service worker xoá sạch mọi listener).
3. **Bridge RPC chưa bao giờ trả được kết quả.** `rpc-handler` trả lời bằng `sendResponse()`, nhưng cả shim lẫn `rpc-client.ts` đều chờ một message `synapse:rpc-result` GỬI TỚI — thứ không ai broadcast. Mọi lời gọi treo vĩnh viễn, không lỗi ở bất kỳ console nào. Sống sót lâu vì 2 method duy nhất từng dùng thật (`cache.get/set`) chưa từng verify bằng browser, và cả 2 đầu đọc code đều "trông đúng". Vá: `await` chính promise `sendMessage` ở cả 2 transport + 3 test đi TRỌN VÒNG.

Cũng tại đây: shim bọc TOÀN BỘ trong 1 IIFE (không có nó, script thứ 2 trên trang chết vì redeclaration `SyntaxError` — platform chỉ chạy được 1 user script). Namespace storage `script:<moduleId>:<userKey>` ([script-storage.ts](../src/adapters/browser-extension/module-registry/script-storage.ts)) bịt lỗ leo thang `cache`. Grant reset khi source đổi (`{scopes, sourceHash}` SHA-256).

**Xong khi — 4/4 ĐÃ ĐẠT, xác nhận bằng Chrome thật** (fixture: [docs/examples/](examples/)): 2 script cùng chạy độc lập, mỗi cái mang đúng uuid của chính nó; namespace storage cách ly đúng (`synapse:grants`/`uploaded`/`activation` đọc ra `undefined`); consent UI tách rõ Enforced/Disclosed; `bus` không còn trên bề mặt user script.

### 11.4 Phase 3 — `synapseApi.ui.*` + compositor (cơ chế A) — đã xác nhận đầy đủ bằng browser thật

`utils/floating-widget.ts` XOÁ HẲN → [`utils/ui-compositor.ts`](../src/adapters/browser-extension/utils/ui-compositor.ts) + [`shared/ui/surface-policy.ts`](../src/shared/ui/surface-policy.ts) (17 test). Mô hình + mọi ràng buộc thiết kế ở [design.md §10](design.md#10-ui-compositor--shadow-dom-surfaces-for-scripts-synapseapiui).

**4 bug thật, tất cả CHỈ lộ ra khi chạy browser thật** (không test tự động nào bắt được):

1. **Stylesheet chỉ được cài như tác dụng phụ của việc vẽ** ⇒ trên trang không có bundled Module nào vẽ (đa số trang!), UI của MỌI user script mất style. Triệu chứng đánh lừa 2 hướng: trông như lỗi CSP, và chỉ lộ khi tắt một module **không liên quan gì**. Vá: `installUiStyles()` gọi vô điều kiện.
2. **Mute teardown thay vì ẩn** ⇒ valve một chiều: hiện lại chỉ được cho owner tự vẽ lại được. Vá: mute = `display:none`.
3. **Zone tạo trùng** khi shim tạo trước content script ⇒ `querySelector` phân xử bằng "cái nào đứng trước" — lại đúng thứ phase này dựng ra để diệt. Vá: kiểm từng zone.
4. **Valve chưa từng chạm tới user script** (`destroyUiSurface` thay vì `setOwnerUiHidden` ⇒ không ghi cờ DOM). Trông như chạy đúng chỉ vì script fixture đã vẽ xong từ trước.

2 lỗi thuộc **fixture** (không phải compositor), cùng là bài học lặp: panel B đè panel A (2 panel DOM trần cùng z-index, `top` cứng — minh hoạ ngược đúng bài toán compositor giải); badge neo nhầm `h1` vì `querySelectorAll('img, …, h1, …')` trả **document order** chứ không phải thứ tự selector.

**Xong khi — ĐẠT, xác nhận bằng Chrome thật** (fixture [`synapse-ui-a.js`](examples/synapse-ui-a.js) + [`synapse-ui-b.js`](examples/synapse-ui-b.js), trang CSP nghiêm tự dựng): ownership (A dismiss id của B chỉ xoá của A); `style-src 'self'` (`adoptedStyleSheets` thắng, control box `<style>` bị CSP nuốt như thiết kế); sorted insertion xuyên 2 world (rủi ro kiến trúc lớn nhất của phase, `environment: 'node'` không kiểm được); quota + rate limit khớp số; van xả 2 chiều.

### 11.5 Phase 4 — Trục `features/`

Feature media detect→download là ~4.800 dòng, 43% repo, trải 8 thư mục, không có thư mục của riêng nó. Refactor thuần cấu trúc — cùng kỷ luật §11.2. `features/{media,http-mock,reader-mode}/`; `utils/` co từ hơn 2.100 xuống **1.392 dòng**, chỉ còn mechanism dùng chung ≥2 feature. Quy ước hậu tố + 2 glob auto-discovery ở [design.md §11](design.md#11-features--directory-axis--context-suffix-convention). Build xác nhận output chunk giữ nguyên hash so với trước refactor (bằng chứng graph import không đổi hình dạng).

### 11.6 Phase 5 — Mở API surface thật (Track API, 9 mục — đóng lại hoàn toàn)

Đây là chỗ "user thực sự viết được automation". Danh sách API + catalog scope ở [`docs/api-inventory.md`](api-inventory.md); quyết định phân loại/tái dùng scope ở [design.md §12](design.md#12-automation-model-scopes-with-resource-match-secrets-and-pipeline-hooks).

Nguồn của danh sách đổi: trước đây là "cái builtin tình cờ cần" — một nguồn có điểm mù cấu trúc (builtin chạy ở background, vốn đã đủ đặc quyền, nên không bao giờ đau ở chỗ user script đau). Nay chạy **hai trục song song**: **SÀN** (parity `chrome.*`/`GM_*` — hữu hạn, đóng được, không cần đoán use case) và **TRẦN** (domain — là lý do đổi sang Synapse, nhưng là cam kết bảo trì vĩnh viễn; ship hẹp, đánh dấu experimental).

| Item | Trạng thái | Manual test |
|---|---|---|
| 1. `net.request` ×match | ✅ Đã xác nhận bằng browser thật | — |
| 2. `files.save` | ✅ Đã xác nhận bằng browser thật | — |
| 3. `lib.*` spike (`hls.parse`/`readable`/`toMarkdown`/`zip`) | ✅ Đã xác nhận bằng browser thật | [test-lib-hls-parse.js](examples/test-lib-hls-parse.js) |
| 4. Template `reader-mode` | ✅ Đã xác nhận bằng browser thật | [test-lib-reader-mode.js](examples/test-lib-reader-mode.js) |
| 5. `net.mock` | ✅ Đã xác nhận trọn vẹn bằng browser thật | [test-net-mock.js](examples/test-net-mock.js) |
| 6. `media` (`list`/`inspect`/`download`/`job`) | ✅ Đã xác nhận bằng browser thật | — |
| — `lib.matchPattern` (phát sinh giữa phiên) | ✅ Đã xác nhận bằng browser thật | [test-lib-match-pattern.js](examples/test-lib-match-pattern.js) |
| 7. `page.eval` | ✅ Đã xác nhận bằng browser thật (happy path) | — |
| 6b. Secret Service | ✅ Qua lượt test đầu, còn vài case nhỏ — xem [TEST_PLAN.md](TEST_PLAN.md) | [test-secrets.js](examples/test-secrets.js) |
| 7b. `ai.ask` | Implement xong, CHƯA verify — xem [TEST_PLAN.md](TEST_PLAN.md) | [test-ai-ask.js](examples/test-ai-ask.js) |
| 8. Tier 2 `pipeline.hook` | ✅ Qua lượt test đầu bằng browser thật (bilibili.tv) | [test-pipeline-hook.js](examples/test-pipeline-hook.js) |
| 9. Trang Help + `synapse-ai-context.md` | Implement xong, CHƯA verify — xem [TEST_PLAN.md](TEST_PLAN.md) | — |

**Chi tiết đáng nhớ:**

- **`net.request`** kéo theo `shared/match-pattern.ts` (matcher đúng chuẩn Chrome match pattern, viết mới thay vì tái dùng glob substring) + `grantsAllow`/`resourceUrlForCall` học cách kiểm resource dimension — hạ tầng dùng chung cho mọi scope mang `match` về sau.
- **`files.save`** — bug tự bắt được lúc viết test (không phải sau ship): cap kích thước nằm SAU bước base64-encode (`bytesToBase64` là vòng lặp JS từng byte) → cap 25MB không chặn được phần tốn thời gian, test mất 2.8s. Vá: đo kích thước (`TextEncoder`/`atob`, native) TRƯỚC khi encode; cap hạ xuống 10MB.
- **`lib.*` cơ chế giao hàng**: `{file}` trong `chrome.userScripts.register`'s `js` (không phải nhét text vào shim string), liệt kê làm entry ĐẦU trước `{code: shimmed}`. Payload từ 1.8KB (chỉ `hls.parse`) lên **49.85KB** sau khi gộp Readability+Turndown+zip — số thật để tham chiếu khi cân nhắc thêm thư viện.
- **Bug thật `lib.*` khi ≥2 script cùng active** (tìm ra qua `lib.matchPattern`): shim đọc `globalThis.__synapseLib` rồi `delete` NGAY (y hệt pattern `__synapseModule`) — nhưng `{file}` là ĐÚNG một resource URL cho mọi script, Chrome không chạy lại riêng cho từng script trên cùng trang, nên script chạy sau nhận `ctx.api.lib` là `undefined` hoàn toàn. Vá: **bỏ hẳn `delete`** — an toàn vì (khác `__synapseModule`) `lib` không mang danh tính script nào. Xem [LESSONS.md](LESSONS.md#chromeuserscriptsregister--nhiều-script-chia-sẻ-cùng-một-file-entry).
- **`net.mock`** — bug thật ở lượt verify đầu: `await import(...)` ĐỘNG bị Vite bọc bằng `__vitePreload`, helper đó gọi `document.head.appendChild` → kéo `document.*` vào bundle SERVICE WORKER. Vá: quay lại import TĨNH + `vi.mock()` cho test riêng. Xem [LESSONS.md](LESSONS.md#bundler-viterollup-giả-định-môi-trường-có-dom). Nhân tiện vá `rpc-handler.ts`: nhánh `catch` quanh implementation thật giờ `console.error` (khác nhánh `fail()` cho denial có chủ đích, vẫn im lặng đúng như trước).
- **3 vòng verify `net.mock` tiếp theo lộ 3 cái sai của chính BÀI TEST, không cái nào của `net.mock`:** (1) verify từ console SERVICE WORKER thay vì world MAIN của trang. (2) `add()`+`remove()` trong cùng `run()`, xong trong vài chục ms — rule bị xoá từ lâu trước khi user gõ xong lệnh verify. (3) Bản sửa (2) bằng "toggle theo lần chạy" lại sai tinh vi hơn: `chrome.scripting.registerContentScripts` KHÔNG áp ngược lại tab ĐANG MỞ SẴN, chỉ hiệu lực từ lần navigate kế — mà reload trang vừa là bước BẮT BUỘC để interceptor chạy, vừa kích hoạt lại `run()` tự xoá mất rule. Sửa cuối: `run()` chỉ `add()` nếu chưa có, KHÔNG BAO GIỜ tự `remove()`; dọn dẹp giao cho Management View. Cả ba ghi vào [LESSONS.md](LESSONS.md#viết-user-script-test-thủ-công-docsexamplestest-js-upload-qua-chromeuserscripts).
- **`media`** — `list()` đi qua ĐÚNG `collapseVariantShadowedEntries` Side Panel/Dashboard dùng (script thấy đúng danh sách Side Panel thấy, không phải bản thô); `download()` tự sinh `jobId` mới, gửi qua ĐÚNG hạ tầng Side Panel dùng ([`engine-relay.background.ts`](../src/adapters/browser-extension/features/media/download/engine-relay.background.ts) tách ra để hai đường dùng chung); `job()` poll snapshot Map đổ đầy bởi listener MỚI cho `synapse:download-engine-event`.
- **`page.eval`** — scope cao nhất catalog. Method **đầu tiên** mà resource dimension đến từ `sender.tab.url` do `rpc-handler.ts` tự đọc, KHÔNG từ `args` — một `url` do script tự khai chỉ là lời TỰ XƯNG, không phải bằng chứng. `pageEvalRunner` bọc `code` bằng `new Function` và gói mọi kết quả thành `{ok, result?, error?}` NHƯ DỮ LIỆU (cách các version Chrome forward throw từ `func` chưa từng được kiểm chứng trong codebase này). Giới hạn v1 ghi rõ: trang có CSP chặn `unsafe-eval` chặn được chính `new Function`.
- **2 bug thật `page.eval` ở lượt verify đầu:** (a) thông báo từ chối quá chung chung để tự chẩn đoán — nguyên nhân thật là test trên domain khác domain đã `match` (đúng thiết kế fail-closed), vá bằng tách 3 message riêng, và tự nó là bằng chứng `sender.tab` hoạt động đúng cho `onUserScriptMessage` (câu hỏi treo trước đây). (b) gọi không kèm `args` nhận `Error: "args" must be an array` — Chrome biến `args` omitted thành `null` qua `sendMessage`, mà default parameter JS chỉ thay `undefined`. Vá: kiểu `unknown[] | null | undefined` + `args ?? []`.
- **Secret Service** — reference-only, 3 lớp kiểm tra độc lập, xem [design.md §12](design.md#12-automation-model-scopes-with-resource-match-secrets-and-pipeline-hooks). `SecretRecord` (`shared/secrets.ts`) lưu qua CacheService ở `features/secrets/secret-store.background.ts`. UI field type mới `'secret'` (luôn hiện `••••••••`, để trống lúc Save nghĩa là "giữ nguyên"). Catalog scope chạm đúng trần ~10.
- **Bug thật Secret Service, lượt test đầu của user: "sau khi save không có secret nào trên Dashboard" — save KHÔNG báo lỗi gì.** `SecretsModule` khai `needs: ['cache']`, **thiếu `'bus'`** (copy nhầm từ doc comment của một store thuần thay vì từ Module thật). `Kernel.run` chia module bằng đúng điều kiện `m.needs?.includes('bus')` — thiếu nó nghĩa là `chromeRuntimeBus.on('secrets', ...)` KHÔNG BAO GIỜ đăng ký, lệnh upsert rơi vào khoảng không. Không lộ ở UI vì `emitCollectionCommand` chỉ throw khi `response?.ok === false`, mà `undefined?.ok === false` là `false` — save "thành công" im lặng. Vá: `needs: ['bus', 'cache']`.
- **`ai.ask`** — TÁI DÙNG scope `net.request`, không thêm scope thứ 11; `resourceUrl` tự suy endpoint thật theo `provider`/`baseUrl`. `secret-resolution.ts` tách từ `net-request-host.ts` khi `ai.ask` thành caller thứ hai của cùng logic.
- **Bug thật qua `ai.ask` (nhưng là của Dry Run, §12.5): `console.error('...', err)` relay về Studio thành `"... {}"`.** `Error`'s `message`/`stack` là non-enumerable trên prototype (V8) nên `JSON.stringify(new Error(...))` luôn là `'{}'`. Vá: đặc cách `a instanceof Error` TRƯỚC nhánh `JSON.stringify` chung — ảnh hưởng MỌI script từng `console.error(msg, err)` trong Dry Run.
- **Tier 2 `pipeline.hook`** — cơ chế xuyên world: `pipeline-hook-client.ts` hỏi background "ai thắng slot X cho URL này" (RPC nhỏ riêng), rồi bắn `CustomEvent` thẳng trên `window` chung giữa ISOLATED/USER_SCRIPT tới đúng script thắng; script trả kết quả qua `CustomEvent` khác, có timeout 3s rơi về `undefined` — hỏng/chậm không bao giờ treo pipeline của platform. Đăng ký tách 2 nửa: `pipeline.hook` công khai (`in-world`) tự gọi `pipeline.register` nội bộ (`rpc`, có scope check thật). Slot đầu tiên nối vào `[§7.3-open]`'s anchor badge — **cố ý CHỈ CỘNG THÊM**: tín hiệu thứ 4, ưu tiên thấp nhất, chỉ bắn cho phần tử `blob:` mà cả 3 tín hiệu có sẵn đều không giải được.
- **2 bug thật Tier 2 trên bilibili.tv, không phải lỗi cơ chế hook:** (1) `dom-media-observer.content.ts` chỉ install khi `network-sniffer` active, mà module này mặc định TẮT (§12.4) — vá bằng thêm bước bật vào PREREQUISITES của file test. (2) Chuỗi literal `*://*/*` trong JSDoc comment tự đóng comment giữa chừng (chứa sẵn `*/`) → lỗi cú pháp thật (`node --check` xác nhận). Sau vá, cơ chế xuyên world xác nhận đúng trên trang thật.
- **Trang Help** — phát hiện định hình cả thiết kế: `ui/studio/main.ts` đã import `docs/types/synapse-userscript.d.ts?raw` từ trước, chứng minh Vite's `?raw` kéo được file ngoài `src/` vào bundle. Áp lại cho `docs/user-scripts.md?raw`: `synapse-ai-context.md` = header version/date + `user-scripts.md` verbatim + `.d.ts` verbatim — **zero prose viết tay mới, zero rủi ro drift**. Thứ tự "silent-failures trước API reference" đúng miễn phí từ cách sắp.

---

## 12. Script Studio — vòng đời & soạn thảo script trong extension (12.1–12.5)

Phase 2 làm script chạy được và phân quyền được, nhưng vòng đời vẫn dừng ở "upload một file rồi thôi". Quyết định kiến trúc đầy đủ ở [design.md §13](design.md#13-script-studio--in-extension-authoring).

### 12.1 Vòng đời script: tên, đổi tên, tải về, xoá — đã xác nhận rename/download/delete bằng browser thật

`synapse:script-meta` ([storage.ts](../src/adapters/browser-extension/module-registry/storage.ts)) tách khỏi `synapse:uploaded` — sửa tên không đụng source. `resolveScriptLabel`/`resolveScriptFileName` ([shared/resolve-script-label.ts](../src/shared/resolve-script-label.ts)) — 4-tier fallback. Tải về qua `Blob`+`createObjectURL`+`chrome.downloads.download`. `deleteScript(id)` gom đủ 7 chỗ + `clearScriptStorage` vào MỘT hàm trong registry (thêm `deleteActivation`/`deleteSubState` vì bản cũ chỉ có "set false" — để lại ghost entry vĩnh viễn khi mọi id là uuid mới). UI: [`rename-view.ts`](../src/adapters/browser-extension/ui/popup/views/rename-view.ts) + [`confirm-delete-view.ts`](../src/adapters/browser-extension/ui/popup/views/confirm-delete-view.ts) (không `window.confirm()` — dialog chặn đồng bộ trong popup MV3 không đáng tin).

**2 bug thật (phát hiện qua lượt test §12.3, cùng đường Upload):**

1. Upload thất bại `Cannot read properties of undefined (reading 'register')` khi "Allow User Scripts" chưa bật — `chrome.userScripts` là `undefined`, ném đồng bộ. Vá: kiểm `userScriptsPermissionGranted` **TRƯỚC** khi mở hộp thoại chọn file.
2. **Bật "Allow User Scripts" xong vẫn không upload được — phải TẮT HẲN BROWSER mới được.** `background/index.ts` chỉ check MỘT LẦN lúc service worker khởi động, và Chrome không đảm bảo restart service worker khi setting đổi. Chưa có cách sửa triệt để (giới hạn nền tảng) — giảm nhẹ bằng nút **"Reload extension"** (`chrome.runtime.reload()`) ngay trong thông báo lỗi.

### 12.2 Studio + Monaco — đã xác nhận bằng Chrome thật

[`ui/studio/`](../src/adapters/browser-extension/ui/studio/) — Monaco + TS language-service worker dưới đúng CSP mặc định, không cần nới `content_security_policy`. 3 gotcha thật, cả ba ở [LESSONS.md](LESSONS.md): exports-map subpath cho worker file, `javascriptDefaults` default `noSemanticValidation: true`, và `declare let __synapseModule` không gắn được lên `globalThis`.

`?moduleId=<id>` mở script để sửa; không param = "New script" từ template. Save = unregister + register lại, validate bằng chính `chrome.userScripts.register` — lỗi cú pháp reject, hiện nguyên `reason`, KHÔNG lưu, và bản đăng ký CŨ được khôi phục. Grant KHÔNG bị hỏi lại (rehash theo source mới). `ctx.api.` gợi ý thật qua `addExtraLib` + `checkJs` — yêu cầu `__synapseModule = {...}` gán trực tiếp.

**Xong khi — cả 4 điều kiện đã được user xác nhận bằng Chrome thật**, kèm luồng "New script".

### 12.3 Bước (steps): code là nguồn sự thật duy nhất, sidebar sống trong Studio

Chỉ áp dụng cho script upload — Composite Module BUNDLED giữ NGUYÊN trang Steps ở Dashboard (bundled không có source để mở trong Studio). Hai UI song song, phân biệt bằng `entry.source`.

- `__synapseModule` khai `steps: [{id, label?, run}]` **HOẶC** `run`, đúng một trong hai; chuẩn hoá về một shape (`run` → `[{id:'main'}]`). Từ đó registry/UI/kernel chỉ còn biết "pipeline có N bước", N≥1.
- Shim thực thi pipeline (`normalizeManifestSteps`/`runPipeline` chạy client-side trong USER_SCRIPT world — function value không sống sót qua messaging nên không validate được ở background). `stepResults` báo qua một `synapse:manifest-report` thứ hai sau khi pipeline xong.
- Bypass đọc qua round-trip mới `synapse:sub-state-query` — script tự hỏi background `subState` của chính nó ngay trước bước đầu (không qua scope check: script tự đọc cấu hình bật/tắt của chính nó). Toggle có hiệu lực ngay ở lần chạy KẾ TIẾP, không cần re-register.
- Sidebar bấm một bước → cuộn editor đang mở tới dòng định nghĩa (literal-id text search, không AST).
- Popup's nút "Steps" thêm điều kiện `entry.source === 'bundled'` — vá một hồi quy tự sinh (mọi script upload giờ CŨNG có `subModules`).

**2 bug thật ngay lượt test đầu:**

1. **Popup's nút "Grant" biến mất đúng lúc user cần nó nhất.** Lần chạy ĐẦU của bất kỳ script nào cần scope đều throw (đúng như tài liệu ghi), nhưng `buildUploadedEntry`'s nhánh `report.runError` trả cứng `scopes: []` → `ungrantedScopes` luôn rỗng; `list-view.ts`'s nút Grant lại chỉ hiện khi `status === 'ok'`. Hai điều kiện cộng lại: script cần Grant nhất là script duy nhất KHÔNG BAO GIỜ hiện được nút Grant — vòng lặp bế tắc. (Đường code đã tồn tại từ Phase 2; chưa lộ vì mọi `test-*.js` khác đều bọc try/catch.) Vá: tính `requestedScopes` sớm hơn, dùng ở CẢ nhánh lỗi; bỏ điều kiện `status === 'ok'`.
2. **Sidebar bắt buộc phải có một lượt chạy trang thật mới thấy cấu trúc bước** — mâu thuẫn với chính nguyên tắc "code là nguồn sự thật". Vá: preview tĩnh (`parseStepsFromSource`, bracket-depth scan) làm fallback CHỈ KHI chưa có report thật; report thật luôn thắng preview.

**2 vòng polish UI:** nút Save đổi sang icon-only (giữ `title`/`aria-label`); **nút trắng-trên-trắng** — Studio chưa dùng framework UI nào nên `<button>` là NATIVE control (nền sáng), trong khi `.syn-icon-img`'s `filter: invert(1)` biến icon đen thành TRẮNG cho nền tối của trang → biến mất hoàn toàn. Vá: style tường minh nền tối áp dụng CHUNG cho mọi nút trong Studio, không riêng nút vừa lỗi.

### 12.4 Template — và builtin ở lại làm builtin

Clone builtin sinh script mới từ TEMPLATE (không phải bản sao source — 4.800 dòng TS không clone thành `.js` được, và kể cả được thì không ai sửa nổi). Builtin read-only, mặc định tắt, có nút Clone. Template bundle dưới [`ui/studio/templates/`](../src/adapters/browser-extension/ui/studio/templates/) qua `import.meta.glob` (cú pháp `{query:'?raw', import:'default'}` hiện hành, không phải `{as:'raw'}` deprecated); tên file CHÍNH LÀ `templateId`. Mỗi template mở đầu bằng comment nói thẳng nó làm được gì / KHÔNG làm được gì / thiếu scope nào — hoá thành **bản báo cáo khoảng trống của `synapseApi` mà user đọc được**. Bảng so sánh đầy đủ ở [design.md §13](design.md#13-script-studio--in-extension-authoring).

**Default-off: đã ĐƠN GIẢN HOÁ sau khi user test thật.** Bản nháp định gate theo `chrome.runtime.onInstalled`'s `reason === 'install'` — bỏ vì (1) project chưa có user thật nào đã cài, cái cần bảo vệ không tồn tại; (2) vòng dev thật (Reload unpacked) luôn báo `'update'`, KHÔNG BAO GIỜ `'install'`, nên chọn cơ chế mà chính cách test hằng ngày không kiểm được là chọn sai.

**4 vấn đề user tự test thấy ngay sau Clone lần đầu, cả 4 đã vá:**

1. **Nút Grant không hiện cho script vừa Save** — cùng lớp với §12.3 mục 1: nhánh `!report` trả cứng `scopes: []`. Vá: [shared/parse-scopes-from-source.ts](../src/shared/parse-scopes-from-source.ts) parse tĩnh từ source đã lưu, chạy qua `validateModuleManifestShape`/`normalizeScopeGrants` sẵn có (không tự viết luật validate riêng).
2. **Nút action bị bóp méo** khi một hàng có nhiều nút — mọi con trực tiếp của flex container mặc định `flex-shrink:1`, vượt 340px thì TẤT CẢ bị bóp đều. Vá: chỉ `.module-label` được co/truncate, nút/badge còn lại `flex-shrink:0`, `flex-wrap:wrap` làm van an toàn.
3. **Sau Clone không sửa được tên — chỉ Save được với uuid thô.** Vá: `#title` thành `contenteditable` (inline-edit kiểu Excel Online); script chưa Save giữ tạm `pendingLabel`, áp dụng ngay sau Save đầu tiên mint id.
4. **3 builtin vẫn `active: true` dù đã đổi default** — bug lệch read-side/write-side: đổi default ở `chrome-module-registry.ts` (cái popup ĐỌC) không đổi hành vi CHẠY THẬT, vì mỗi Module tự gọi `isModuleActive(id)` hardcode `?? true` riêng. Không vá vế này thì popup hiện toggle tắt trong khi tính năng vẫn âm thầm chạy dưới nền. Vá: `isModuleActive(id, defaultActive=true)`, mọi call site của 3 id truyền `false` tường minh. Kèm: tách popup thành 2 tab "My Scripts"/"Builtin".

### 12.5 Dry Run / Test Run — chạy thử code chưa lưu ngay trên tab hiện tại

`chrome.userScripts.execute()` (shipped Chrome 133, chữ ký ổn định 135; project ở Chrome 150). `@types/chrome@0.0.287` không có method này — vá bằng `declare global` augmentation ngay trong `chrome-module-registry.ts` (cùng khuôn `opfs-store.ts`'s `FileSystemDirectoryHandle`). Quyền hạn mượn grant hiện có / rỗng nếu mới — KHÔNG cần cơ chế riêng nào ở `rpc-handler.ts` (xem [design.md §13](design.md#13-script-studio--in-extension-authoring)).

[`dry-run-shim.ts`](../src/adapters/browser-extension/module-registry/dry-run-shim.ts) tái dùng NGUYÊN `header()`/`normalizerSource()` từ `user-script-shim.ts` — Dry Run gọi `ctx.api` qua ĐÚNG con đường một script đã Save sẽ dùng. `console.*` shadow bằng `var console = {...}` bên trong CHÍNH IIFE (không monkey-patch `window.console` thật — sẽ bắt luôn console của script khác cùng chạy trên trang). Kết quả qua `synapse:dry-run-result`, **KHÔNG BAO GIỜ `synapse:manifest-report`** (một lượt chạy thử code chưa lưu không được đè lên report CONFIRMED). Relay chỉ chạy khi `sender.tab` có giá trị thật — phòng thủ trước rủi ro chưa xác minh "background tự gọi `sendMessage` có tự nhận lại không". Studio UI: nút "Run once on this tab" + `pickDryRunTargetTab()` (`chrome.tabs.getCurrent()` loại trừ tab Studio, sắp theo `lastAccessed`) + console panel lọc theo `runId`.
