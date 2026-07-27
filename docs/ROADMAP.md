# Roadmap

Trạng thái các hạng mục đang xét, dùng làm state memory giữa các phiên làm việc. Không phải build spec — khi bắt tay implement một mục, đọc lại quyết định đã chốt bên dưới trước khi code. Các mục đã implement được viết cô đọng (what/where, không phải nhật ký quyết định) — bài học/gotcha kỹ thuật rút ra trong quá trình làm nằm ở [LESSONS.md](LESSONS.md), không lặp lại ở đây. Mọi việc chưa xong, chưa chốt, hoặc chưa verify được gom về **[Khu vực Open Points](#khu-vực-open-points)** ở cuối file — đọc khu vực đó trước khi nhận việc mới.

## 1. Reader Mode Converter — Đã implement

Composite Module 4 bước (`load-dom` → `clean` → `fetch-images` → `convert-markdown`, qua `createCompositeModule`) + action Crawl site + Review/ZIP page.

- **`HtmlToMarkdownConverter`** ([shared/html-to-markdown.ts](../src/shared/html-to-markdown.ts)) wrap **Turndown**, 2 rule tuỳ biến resolve `src`/`href` tương đối→tuyệt đối. `clean` dùng **`@mozilla/readability`** (không phải heuristic tự viết). `fetch-images` fetch trực tiếp trong content-script, cap ~10MB/ảnh, dedupe theo URL. `convert-markdown` map `Map<absoluteUrl, localPath>`.
- **Crawl & Convert Site** (action thứ 2, dùng lại 100% pipeline trên): discovery qua `robots.txt`/`sitemap.xml`/nav-expand; same-origin, `MAX_CRAWL_PAGES=200`; `fetch()`+`DOMParser` (không phải `chrome.tabs` navigate) để tái dùng nguyên `clean`/`fetch-images`/`convert-markdown`; output file-per-page (không gộp 1 file) qua `pathFromUrl`+`slugify()`.
- **Review page + ZIP**: mở Tab riêng, handoff qua `review-handoff.ts` (ảnh→IndexedDB `blob-store.ts`, text nhỏ→`chrome.storage.session`). ZIP tự viết ([shared/zip.ts](../src/shared/zip.ts), method STORE, CRC32/header/central-directory/EOCD tự viết, không dependency).
- `UIActionSchema` tổng quát hoá thành mảng `actions[]` ([ui-schema.ts](../src/kernel/ui-schema.ts)).

## 2. Module Registry UI — Đã implement

- Declarative UI Schema ([kernel/ui-schema.ts](../src/kernel/ui-schema.ts)): `UISchema = UICollectionSchema | UIActionSchema`. `chrome-module-registry.ts` gộp `BUNDLED_MODULES`+`BACKGROUND_MODULES`.
- Popup: list module + Slide Toggle; module có Setting thêm icon Gear/Arrow mở Management View, module chỉ-Action thì icon trigger thẳng `run()`. Không dùng `<dialog>` trong popup (xem [LESSONS.md](LESSONS.md)) — toàn bộ popup là in-flow view-swap qua `router.ts`.
- Popup + Dashboard đều VanJS + Pico.css (xem mục 2.5).

## 2.5. Trang Quản lý Nội bộ Độc lập (Dashboard) — Đã implement

VanJS (không phải Alpine.js — MV3 CSP chặn `unsafe-eval` mà Alpine cần) + Pico.css.

- Layout dùng chung [ui/](../src/adapters/browser-extension/ui/): `ui/popup/` + `ui/dashboard/` + [module-data-sources.ts](../src/adapters/browser-extension/ui/module-data-sources.ts).
- `router.ts`'s `'management'`/`'item-form'` View đã xoá hẳn khỏi popup — popup chỉ `chrome.tabs.create` mở Dashboard rồi tự đóng.
- Mỗi module tự sở hữu `chrome.storage.local` (không IndexedDB/cơ chế mới cho Collection-schema). `listCollection()` sống trên chính Module (kernel/module.ts) — module mới không cần sửa `module-data-sources.ts`.
- Extra HTML entry (`ui/dashboard/index.html`) khai tay trong [vite.config.ts](../vite.config.ts) — không field manifest nào tự nhận diện trang mở qua `chrome.tabs.create` thuần (xem [LESSONS.md](LESSONS.md)).

## 2.6 + 2.6.1. Nâng cấp Network Interceptor (`http-error-mocker`) — Đã implement

3 mechanism song song qua field `mechanism` ([shared/http-mock.ts](../src/shared/http-mock.ts)), 1 shape `MockConfig` chung:

- **`main-world`:** rẻ nhất, không banner, không hiện Network tab, chỉ mock fetch/XHR.
- **`debugger`:** CDP `Fetch.enable`/`fulfillRequest`/`continueRequest` — hiện đúng Network tab, bắt mọi loại request, nhưng Chrome hiện banner "đang debug tab" liên tục.
- **`dnr`:** declarativeNetRequest, không banner, thuần khai báo (không callback per-request) — `block`/`rewrite-request` (chỉ URL/header)/`fake-response` (redirect sang `data:` URL). Rule ID băm FNV-1a từ `MockConfig.id`.
- Mỗi rule có `action: 'fake-response'|'rewrite-request'|'block'`, giới hạn theo mechanism (main-world chỉ patch fetch/XHR; debugger sửa mọi resource type; dnr chỉ URL+header).
- File tĩnh đóng gói sẵn cho rewrite ([mock-files/](../src/adapters/browser-extension/background/modules/http-error-mocker/mock-files)), enumerate build-time qua `import.meta.glob`.
- Fake file qua upload: `debugger`→IndexedDB (`blob-store.ts`); `main-world`→inline base64 trong `MockConfig` (cap 2MB).
- Kernel-level mới: `showWhen` dạng mảng AND ([ui-schema.ts](../src/kernel/ui-schema.ts)), `UIFieldDef.suggestions`/`advanced` (collapsible panel), `type:'file'` field.

## 3. Module Chain (Composite Module) — Đã implement (chỉ bản tuần tự)

- [kernel/composite-module.ts](../src/kernel/composite-module.ts)'s `createCompositeModule` — không rollback (sub-module throw bị bắt per-step, `onSubFailure`, value giữ nguyên trôi sang bước kế). Không Context Share mutable — `ctx` forward nguyên xuống mọi `sub.run`.
- `RegistryEntry` thêm `subModules`/`subState`. UI sub-toggle sống ở Dashboard's Steps view (popup chỉ có nút mở nó).
- Case nghiệp vụ thật đầu tiên: `reader-mode-converter` (mục 1).

## 4. Generic Network Sniffer / Shadow DOM popover — Đã implement

Business case: phát hiện URL video/audio/stream trang tự request, liệt kê, cho tải về.

- **Phát hiện qua 3 nguồn:** (a) `chrome.webRequest.onHeadersReceived` ([webrequest-media-observer.ts](../src/adapters/browser-extension/utils/webrequest-media-observer.ts), background-only) + `shared/media-url-matcher.ts` (`classifyMediaUrl`/`classifyMediaMimeType`, cố tình loại trừ segment `.ts`/`.m4s`); (b) DOM sniffing (`<video>`/`<audio>` đã render, lazy player); (c) MAIN-world observe-only interceptor cho player MSE (`blob:`) — tái dùng `main-world-interceptor` pattern.
- **Trust split chống junk-URL:** `resourceType==='media'` tin Content-Type trước/URL-extension fallback; nhánh ồn (`xmlhttprequest`/`object`/`other`) bắt buộc Content-Type khớp thật, trừ đuôi `.m3u8`/`.mpd` (luôn tin theo đuôi). `thirdParty` là NHÃN, không phải filter loại trừ.
- **Phủ iframe nested/cross-origin:** content-script riêng `all_frames:true` ([frame-media-observer.ts](../src/adapters/browser-extension/content-scripts/frame-media-observer.ts)); Module `iframe-unsandbox` riêng (mặc định OFF) gỡ sandbox token + DNR rút CSP header khỏi `sub_frame` response.
- **Shadow DOM popover** ([utils/floating-widget.ts](../src/adapters/browser-extension/utils/floating-widget.ts)): `showFloatingWidget`/`showAnchoredBadge`, style qua CSSOM trực tiếp (không `<style>`, xem [LESSONS.md](LESSONS.md)). Badge gắn video là chính; toast fallback cho case webRequest-only. Mở Dashboard qua `sendMessage` relay (không `<a href>` extension URL trực tiếp — xem LESSONS.md).
- `uiParadigm` field (`'none'|'dedicated-page'|'float-widget'|'action-button'`) trên Module/RegistryEntry.

## 5. `network-sniffer` — parse manifest, giảm junk, tải+ghép — Đã implement

- **5.1 Parse `.m3u8` (HLS):** `shared/media-manifest-parser.ts`'s `parseM3u8` — phân biệt master (`#EXT-X-STREAM-INF`, danh sách variant+resolution) vs media playlist (`#EXTINF`, danh sách segment tuyệt đối, cờ `encrypted`). Cố tình chưa làm DASH/`.mpd` (service worker không có `DOMParser`).
- **5.2 Giảm junk-URL:** domain denylist ([shared/ad-domain-denylist.ts](../src/shared/ad-domain-denylist.ts)), path/query keyword heuristic ([shared/junk-url-patterns.ts](../src/shared/junk-url-patterns.ts), whole-segment match), `defaultHideField` kernel-level (ẩn mặc định field boolean nào đó trong Management View, có checkbox bật lại).
- **5.3 Tải + ghép bằng ffmpeg.wasm:** dependency nặng (`@ffmpeg/ffmpeg`+`@ffmpeg/core`+`@ffmpeg/util`, ~32MB), CSP nới `wasm-unsafe-eval`. Trang Merge ban đầu (Tab riêng) — **đã bị xoá hẳn ở §8.1**, giữ lại ở đây chỉ vì lịch sử: pool tải segment, ghép, remux qua ffmpeg, tải xuống.
- Từ 8.3 trở đi, engine tải/ghép đã port sang `utils/download-engine.ts` chạy trong Offscreen Document — xem mục 8, không phải trang Merge nữa.

## 6. `network-sniffer` UI/UX — Floating icon + Side Panel — Đã implement

Thay đổi UX: bỏ nút "Inspect"/2 nút Download rời rạc, gộp N-resolution vào 1 `<select>`/item, icon nổi góc trên-phải thay toolbar action-button (không có API công khai nào cho icon-trong-address-bar kiểu Google Dịch).

- **6.1** `showFloatingIcon`/`dismissFloatingIcon` ([utils/floating-widget.ts](../src/adapters/browser-extension/utils/floating-widget.ts)) — chỉ 2 trạng thái ẩn/hiện, không đếm số chính xác trên icon (số liệu thật nằm ở Side Panel).
- **6.2** Side Panel qua manifest field `side_panel` (crxjs tự nhận diện, không cần Rollup input riêng) — xem [LESSONS.md](LESSONS.md) cho gotcha `sidePanel.open()`.
- **6.3** `store.ts`'s `DetectedMedia` thêm `variants?`; auto-inspect ngầm ngay sau mọi `addDetectedMedia` thành công (bỏ hẳn nút "Inspect"/`op:'inspect'`). Side Panel (`ui/side-panel/`, VanJS riêng, KHÔNG tái dùng `management-view.ts`) query `listDetectedMedia()` scope theo origin tab active.
- **6.5–6.8 bugfix/mở rộng đã gộp vào baseline:** filter junk-URL áp cả lên `pageUrl`/initiator (không chỉ URL request) + `looksLikeAdMacroTemplate` (placeholder `{macro}` chưa thay thế); Side Panel card redesign (kind badge, filename, domain nguồn, DRM badge); Side Panel tự tắt khi tab active là Dashboard; Dashboard's Management View gộp `download`+`open-tab` thành 1 `UIRowAction` kiểu `'smart-download'` (tự chọn `chrome.downloads`/mở tab merge theo `kindField`), thêm `variantsField` render cột resolution-link.

## 7. Sniffing & Detector — bổ sung theo checklist — Đã implement (7.1–7.5)

- **7.1 Bắt & replay Request Headers** (Referer/Origin/User-Agent/Range) — `onSendHeaders`+`extraHeaders` ghép theo `requestId` ([webrequest-media-observer.ts](../src/adapters/browser-extension/utils/webrequest-media-observer.ts)); replay qua DNR session rule ([header-replay-rules.ts](../src/adapters/browser-extension/utils/header-replay-rules.ts)), KHÔNG lưu Cookie/Authorization. **Đã xác nhận bằng browser thật.** Gotcha DNR `tabIds`/`TAB_ID_NONE` — xem [LESSONS.md](LESSONS.md).
- **7.2 Magic bytes / payload sniffing** — `shared/media-magic-bytes.ts`'s `sniffMediaMagicBytes` (chữ ký `#EXTM3U`/TS 3-điểm/`ftyp`/`1A45DFA3`/`OggS`/`RIFF`/MP3/AAC). Probe chủ động `Range: bytes=0-1023` chỉ khi thực sự mù (Content-Type octet-stream/rỗng VÀ đuôi URL không nhận diện), cap đồng thời + cache theo origin, cố tình KHÔNG tái dùng header-replay cho probe (xem [LESSONS.md](LESSONS.md)).
- **7.3 Correlation MSE chính xác** — (a) hook `URL.createObjectURL`/`MediaSource.addSourceBuffer` (`utils/main-world/media-source-interceptor.ts`); (a-hls) hook `window.Hls` global qua `Object.defineProperty` accessor (`utils/main-world/hls-global-hook.ts`), bắt `MANIFEST_LOADED` lấy thẳng URL+`<video>`; (play) `document.addEventListener('play', fn, true)` capture-phase thu hẹp cửa sổ tương quan. `dom-media-observer.ts` bỏ hẳn biến toàn cục `lastMainWorldMediaUrl`. **(b) hook `SourceBuffer.appendBuffer` vẫn hoãn** — xem Open Points.
- **7.4 URL ký/hết hạn** — `shared/signed-url-detector.ts`'s `looksLikeSignedUrl` (nhãn, theo tên query key). Tự phục hồi 401/403 giữa lượt tải: fetch lại manifest, remap theo index (chỉ khi VOD/`!isLive`, ngân sách 1 lần/lượt tải). Bug tiện sửa: vòng lặp tải trước đây không check `res.ok`.
- **7.5 Ad-filter mở rộng** — thêm path segment (`vast`/`vpaid`/`ima`/`prebid`/...) + `looksLikeAdHostnamePrefix` (tiền tố hostname `creative.`/`ads.`/`adserver.`/`track.`/`pixel.`, [ad-domain-denylist.ts](../src/shared/ad-domain-denylist.ts)).
- **7.6 Download UX nền** — Tab Merge mở `active:false`, tự chạy ngay (bỏ nút "Start Download" thủ công), progress-relay qua `chrome.runtime.sendMessage({type:'synapse:merge-progress', entryId, phase, done, total})`, Side Panel hiện `<progress>` Pico. (Đã thay thế hoàn toàn bởi Offscreen Document engine ở §8.1 — mục này giữ ý tưởng UX, không phải cơ chế cuối cùng.)

## 8. Downloader Engine — Đã implement (8.1–8.11)

Đối chiếu checklist "Web Worker Downloader Engine": đã có đủ — parse manifest, staging OPFS, pool song song + retry/backoff, giải mã AES-128, remux qua `ffmpeg.mount(WORKERFS)`, fallback lưu `.ts` khi vượt ngưỡng remux, chạy trong Offscreen Document với message protocol, export qua Blob+`chrome.downloads`, multi-connection Range downloader opt-in.

- **8.1** Xoá hẳn `ui/merge/` (Tab cũ) — port sang [`utils/download-engine.ts`](../src/adapters/browser-extension/utils/download-engine.ts), chạy headless trong Offscreen Document singleton (`utils/offscreen-manager.ts`). Protocol: [`shared/download-engine-protocol.ts`](../src/shared/download-engine-protocol.ts) (`DownloadEngineCommand`: START/PAUSE/RESUME/CANCEL; `DownloadEngineEvent`: phase discriminator). Background chỉ là relay (xem [LESSONS.md](LESSONS.md) cho gotcha Offscreen Document chỉ có `chrome.runtime`). Pause/Resume ở ranh giới segment qua `JobControl{cancelled,pausedPromise,...}`; ETA ước lượng từ bytes/elapsed, không cần đổi parser.
- **8.2** Multi-connection Range downloader — opt-in "Turbo download", mặc định OFF. Dùng chung `download-engine.ts`/`JobControl`, command `START_TURBO`, phase `'chunks'`. Ghi OPFS theo offset (`OpfsRun.write`'s tham số `position?`). CANCEL huỷ thật qua `AbortController` per-chunk (khác HLS). Probe HEAD/Range xác nhận server hỗ trợ range, `MIN_TURBO_SIZE_BYTES=5MiB`. Tái dùng header-replay §7.1. Chỉ ở Side Panel (1 checkbox toggle, persist `chrome.storage.local`), không có ở Dashboard.
- **8.3** Pool song song `SEGMENT_POOL_SIZE=5` (bỏ delay cố định cũ) — `pendingWrites`/`flushReady()` giữ đúng thứ tự ghi dù tải xong không theo thứ tự; retry tối đa 3 lần (backoff) trước khi coi là lỗi thật (không skip-and-continue).
- **8.4** Giải mã AES-128 per-segment — phân biệt bắt buộc AES-128 (giải mã được) vs SAMPLE-AES/DRM thật (chặn cứng, xem [LESSONS.md](LESSONS.md)). `parseM3u8` trả `key?` theo từng segment (khoá xoay giữa playlist), viết lại parser thành state-machine tổng quát.
- **8.5** OPFS thay IndexedDB — sửa OOM thật (`ffmpeg.writeFile` copy vào MEMFS/wasm heap, không phải chỉ mảng JS — xem [LESSONS.md](LESSONS.md)). `createOpfsRun`/`FileSystemWritableFileStream` ghi theo offset; remux qua `ffmpeg.mount(WORKERFS)`; `REMUX_SIZE_CAP_BYTES=2GB` — vượt ngưỡng tự động fallback lưu `.ts` thẳng (đã là file phát được, TS tự đồng bộ theo packet 188 byte).
- **8.6–8.11 bugfix từ test thật (browser thật), đã áp dụng vào baseline trên:**
  - `chrome.sidePanel.open()`/DNR gotcha (xem [LESSONS.md](LESSONS.md)).
  - Relay tự gửi trùng message cùng type → `OPFS InvalidStateError` — tách `DownloadEngineRelayedCommand` khỏi type client-facing (xem [LESSONS.md](LESSONS.md)).
  - VanJS `render()` không diff DOM → nhấp nháy/rớt click dưới event tần suất cao — `scheduleRender()` coalesce qua `requestAnimationFrame` (xem [LESSONS.md](LESSONS.md)).
  - `inFlight` phải đếm theo trọn vòng đời item (fetch+ghi), không theo attempt — race khiến `'paused'` bị `'segments'` đến sau đè lại (xem [LESSONS.md](LESSONS.md)). CANCEL cho HLS giờ huỷ thật qua `AbortController` (trước đây để fetch dở chạy hết tự nhiên).
  - `sweepStaleOpfsRuns()` dọn file mồ côi khi Offscreen Document mới khởi động (OPFS `InvalidStateError` sống sót qua reload extension).
  - Offscreen Document chỉ dùng được `chrome.runtime` — relay `chrome.storage`/`downloads`/`declarativeNetRequest` qua background (`requestFromBackground<T>`); một listener cũ thiếu type-guard từng giành mất response (đã thêm guard).

## 9. Rà soát UI Surface Placement — Đã đối chiếu (phần lớn khớp, 1 điểm lệch)

Đối chiếu khung quyết định [`ui-surface-placement`](../.claude/skills/ui-surface-placement/SKILL.md) — Popup=tương tác <10s/toggle, Dashboard=CRUD/tác vụ dài, Shadow-DOM=hành động gắn 1 phần tử, Side Panel=tương tác nhiều lượt song song trang.

- Side Panel: mục 6 là ca dùng đầu tiên (đã implement) — vẫn ưu tiên cho nhu cầu tương lai dạng multi-turn gắn 1 tab (chat/dịch/ghi chú, `PersonaAutomationAgent`), chưa sửa `docs/design.md` §7 cho tới khi có Module thứ 2 dùng lại.
- Các bề mặt còn lại đã khớp nguyên tắc: Popup (Module Registry), Dashboard (Management/Steps/Review-ZIP), Shadow DOM (badge/toast/icon nổi).
- **Điểm lệch còn treo (Crawl progress sống trong Popup) — xem Open Points.**

---

## Khu vực Open Points

Mọi việc chưa xong, chưa chốt hướng, hoặc chưa verify — gom theo khu vực. Đọc trước khi bắt việc mới trong khu vực tương ứng.

### Chưa implement / chưa chọn hướng

- **[§8.12] State management cho download job (persist + resume sau khi bị ngắt, vd tắt browser).** Quyết định khung đã chốt, CHƯA code: chỉ áp dụng cho job HLS (không turbo — không có checkpoint tự nhiên nhỏ hơn); checkpoint định kỳ (coalesce theo nhịp `scheduleRender`, không phải mỗi segment) lưu `{jobId, manifestUrl, opfsRunId, lastConfirmedSegmentIndex, lastConfirmedByteOffset, total, resolutionLabel}`; resume PHẢI đối chiếu `file.size` thật trên OPFS với checkpoint (không tin mù số đã lưu — nhỏ hơn thì bỏ hẳn/tải lại, lớn hơn/bằng thì `truncate()` về đúng offset); refetch+reparse manifest tại thời điểm resume (chỉ khi VOD); không tự động resume (user tự bấm "Resume available"); dọn checkpoint khi job kết thúc ở bất kỳ trạng thái nào. Chưa quyết: UI resume ở Side Panel hay cả Dashboard; có cần giới hạn tuổi checkpoint không.
- **[§9.1] Crawl & Convert Site's progress sống trong Popup — lệch nguyên tắc "Popup chỉ cho tương tác <10s".** Crawl tuần tự tới 200 trang dễ vượt vòng đời Popup (đóng khi mất focus) → mất kết quả giữa chừng. Hai hướng chưa chọn (cần đo thời gian crawl thật trước): (a) bấm Crawl → mở ngay Dashboard/Tab hiện progress, popup tự đóng; (b) giữ trigger ở popup, progress chạy nền + `chrome.notifications` báo xong. Reader Mode đơn trang không dính vấn đề này.
- **[§10.1] Video stream trực tiếp/liên tục (LL-HLS, media-sequence tăng dần, không có tập segment cố định).** Toàn bộ giả định của engine hiện tại (parse 1 lần → biết `total` → pool tải → nối → remux) sai từ gốc cho case này — cần vòng lặp refetch-manifest-theo-chu-kỳ + phát hiện segment mới + append tới khi user dừng. Nên là phase riêng. Pause/resume/stop cần cho MỌI loại video (kể cả VOD lớn đang tải dở), không riêng gì live — không gộp chung với việc parse live. `chrome.downloads` có pause/resume/cancel sẵn của trình duyệt gần như miễn phí; engine tự viết (pool+OPFS+ffmpeg) phải tự implement toàn bộ (cờ huỷ ngoài, giữ `opfsRun` sống qua pause, kênh điều khiển 2 chiều Side Panel↔Tab). Chưa quyết "xong" nghĩa là gì cho live (user bấm stop? tới `#EXT-X-ENDLIST`? giới hạn thời lượng?) và remux ở thời điểm nào.
- **[§10.2] Ad-filter cho stream trực tiếp — làm SAU 10.1.** Cố ý chưa lọc (cần case thật để hoàn thiện logic bắt link trước). Đã biết: 3 nguồn phát hiện bất đồng (webRequest thấy `initiator` thật của iframe quảng cáo, MAIN-world/DOM chỉ thấy `pageUrl` trang chủ → cùng 1 stream lọt/bị chặn tuỳ nguồn nào bắt trước — không nhất quán, không phải bug); không thêm domain sạch (vd `sacdnssedge`) vào denylist — cần tín hiệu khác (initiator frame, quan hệ với VAST/VPAID đã thấy trên trang).
- **[§10.3] Media MSE không lộ manifest — lớp URL chưa từng bắt được** (player tự viết lấy chunk từ endpoint JSON thường, không phải `.m3u8`/`.mpd`; magic-bytes không nhận `moof`/`styp` fMP4 media segment — chỉ có `ftyp` init segment; `probedMagicByteOrigins` đánh dấu vĩnh viễn bất kể kết quả, dễ "đốt" origin oan). Sửa nhanh chưa làm: (i) chỉ đánh dấu probe khi thật sự vô ích/cap theo số lần; (ii) thêm `styp`/`moof` vào magic-bytes như kind mới. Đường tổng quát thật sự là **§7.3(b) hook `SourceBuffer.appendBuffer`** — mệnh đề cũ "chưa gặp ca thật nào bắt buộc" nay đã sai, đây chính là ca đó (đánh đổi cũ vẫn đúng: chỉ lấy phần đã phát, không nhanh hơn real-time, tốn kênh structured-clone, cần remux nếu nhiều SourceBuffer).
- **[§10.4] Scope theo tab mới sửa được một nửa.** `DetectedMedia.tabUrl` chỉ có ở nguồn webRequest (có `tabId` để tra). `report-dom-media`/`report-main-world-media` gửi `pageUrl=location.href` của chính frame, không có `tabUrl` → vẫn bị ẩn khi ở trong iframe khác origin (đúng đường mà 10.3 đi qua — hai mục chồng lên nhau). Hướng: `sender.tab.url` có sẵn trong `chrome.runtime.onMessage` listener của background (top-level, kể cả khi message đến từ iframe con), nhưng `run()` của Module không nhận `sender` — chưa chọn cách nối giá trị đó vào entry.
- **[§2.6.1] `rewriteBody` qua file upload chưa hỗ trợ** (chỉ `fakeResponse` được upload).
- **[§3] `http-error-mocker` chưa ghép vào Composite Module nào** — cố ý, chưa có chuỗi input/output hợp lý, chờ nhu cầu thật.
- **[§7.3(b)] Hook `appendBuffer` để bắt byte trực tiếp — hoãn** (xem §10.3, giờ đã có ca thật cần nó nhưng vẫn chưa làm).

### Rủi ro/quyết định mở

- **[§1] Đóng popup giữa chừng lúc crawl mất kết quả** — response chỉ trả 1 lần lúc kết thúc, chưa xử lý (liên quan trực tiếp §9.1).
- **[§6.4]** Side Panel do Chrome quản lý per-window (không phải per-tab) — hành vi khi đổi tab/window trong cùng cửa sổ chưa kiểm tra kỹ ngoài việc filter theo origin.
- **[§8.6 note]** 7.1 (header replay) và 8.2 (Turbo Range) đều phát request từ context extension → cùng câu hỏi "DNR có áp lên request của chính extension không" — đã verify qua 7.1, dùng chung kết luận cho 8.2.
- **[§8.11]** Lỗi gốc (`chrome.downloads`/`storage`/`declarativeNetRequest` đều `undefined` trong Offscreen Document) đã xác nhận bằng browser thật; **bản vá relay 3 kênh mới (query-replay-headers/sync-header-replay-rule/describe-header-replay/trigger-download) CHƯA được re-verify bằng browser thật** — cần xác nhận không bị listener khác giành response, và header replay thật sự hoạt động (không chỉ hết bị nuốt lỗi im lặng) trên site hotlink-protect thật.

### Chưa verify bằng browser thật (agent không có môi trường trình duyệt)

Baseline: engine tải (§8.1–8.5) và Side Panel (§6) đã qua **nhiều vòng test thật của user** (đó là cách §6.6–6.7, §8.6–8.11 được phát hiện) — phần lớn rủi ro runtime ban đầu coi như đã đóng cho luồng chính (HLS pool+AES-128+remux+Pause/Resume/Cancel, header replay §7.1, VanJS render §8.9 — cả hai **đã xác nhận bằng browser thật**). Danh sách dưới đây là phần **CHƯA từng được user xác nhận**, hoặc bản vá mới nhất chưa re-test sau khi sửa:

- **§4.2/6.1** Icon nổi/badge: bám đúng vị trí khi cuộn/resize, tự ẩn/gỡ đúng lúc.
- **§5.1** Inspect (nay là auto-inspect §6.3) ra đúng danh sách resolution cho master playlist thật, patch đúng `segmentCount`/`encrypted` cho variant thật.
- **§5.2** Domain/path/query-key filter trên site thật ngoài các case đã gặp (mới verify bằng pure-function check).
- **§6.8** Click từng resolution link trong Dashboard mở đúng variant URL (không phải variant đầu).
- **§7.2** Magic-bytes probe bắt đúng manifest bị serve sai Content-Type trên site thật; cache theo origin không chặn nhầm URL hợp lệ khác cùng origin.
- **§7.3** Trang có ≥2 player MSE cùng lúc không còn gán lẫn URL giữa 2 badge; `window.Hls` accessor không vỡ trên site dùng bundler lạ; `'play'` capture-phase bắt được trên site chặn `stopPropagation()`.
- **§7.4** Một CDN thật trả 401/403 giữa lượt tải, refresh-manifest-rồi-remap thật sự vá được phần còn lại.
- **§7.5** Chưa xác nhận trên site thật có request nào thật sự mang các tín hiệu path/hostname-prefix mới.
- **§8.2 (Turbo)** Ghi OPFS đồng thời theo offset ra đúng byte; `AbortController`-huỷ fetch dọn sạch; tỉ lệ probe HEAD/Range nhận đúng server hỗ trợ range trên CDN thật.
- **§8.10** `'pausing'`→`'paused'` không bao giờ kẹt dưới tải mạng thật; bấm Download lại ngay sau Cancel luôn là job hoàn toàn mới.

Khi verify xong một mục ở trên, xoá bulletpoint đó khỏi đây (đừng chuyển nó thành ghi chú "đã test" trong phần thân — thân bài đã giả định đúng theo thiết kế, chỉ cần dọn cảnh báo).
