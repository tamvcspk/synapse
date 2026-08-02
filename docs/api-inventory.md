# API Inventory — sàn (parity) và trần (domain)

Nguồn của danh sách API cho Phase 5 ([ROADMAP §11.6](ROADMAP.md#116-phase-5--mở-api-surface-thật)). Trước đây danh sách đó đến từ "cái builtin tình cờ cần" — một nguồn có **điểm mù cấu trúc**: builtin chạy trong background, vốn đã có sẵn mọi đặc quyền, nên nó không bao giờ *đau* ở đúng chỗ user script đau. Bằng chứng: [`scopes.ts`](../src/kernel/scopes.ts) ghi `page.fetch` *"is NOT the same as making requests under the extension's identity, which no scope grants yet"* — fetch cross-origin dưới danh nghĩa extension (`GM_xmlhttpRequest`, API được dùng nhiều nhất của toàn hệ sinh thái userscript) vẫn chưa có, sau 11 phase.

Doc này là **bản kiểm kê + triage**, không phải build spec. Khi implement một mục, đọc "Xong khi" của Phase 5 và các quyết định §11.0 trước.

## 0. Hai trục, hai nhiệm vụ, hai tốc độ mục ruỗng

| | **SÀN** — parity | **TRẦN** — domain |
|---|---|---|
| Nguồn danh sách | Delta đặc quyền của `chrome.*` + bộ `GM_*` | `features/` đang có trong repo |
| Vai trò | Điều kiện **cần**: script Tampermonkey cơ bản chạy được | Điều kiện **đủ**: lý do đổi sang Synapse |
| Đoán trước được không | **Không cần đoán** — danh sách hữu hạn, đóng được, có prior thực nghiệm 15 năm | Phải đoán, nên đi theo use case như cũ |
| Tốc độ mục ruỗng | Gần bằng 0 — `chrome.*` do Google giữ versioned | **Cao** — mỗi API là lời hứa giữ engine chạy được trước site liên tục đổi (`[§7.3-open]`, `[§10.2]`, `[§10.3]` là chi phí định kỳ đó) |
| Cách ship | Rộng, tự tin, một lần | Hẹp, đánh dấu experimental, mỗi cái phải trả lời "ai bảo trì khi site đổi" |

Cả hai đều lộ ra qua **đúng một bề mặt công khai: `synapseApi`** (§11.0). `features/` là chỗ code sống, không phải chỗ hợp đồng sống.

## 1. Bộ lọc — 3 câu hỏi, theo thứ tự

Một API chỉ vào catalog khi qua cả ba. Bỏ qua câu nào cũng đã có tiền lệ hỏng trong repo này.

1. **Delta đặc quyền** — script tự làm được không? Làm được ⇒ không phải API, cùng lắm là `disclosed` (`page.dom`/`page.fetch`). Đây là trục `enforced`/`disclosed` đã có, dùng ngược lại làm bộ lọc đầu vào.
2. **Chia được theo mục đích** — expose trần có thành god-capability không? `chrome.debugger` là ca cực đoan: CDP đọc được mọi trang, mọi cookie, execute mọi thứ. Không chia được ⇒ **chỉ lộ qua wrapper mục đích**, không bao giờ trần. (Đây chính là bài học `bus` ở §11.0, áp cho `chrome.*`.)
3. **Diễn đạt được qua ranh giới** — structured clone: không function tham số, không object sống, mọi thứ async ([synapse-api.ts](../src/kernel/synapse-api.ts#L13-L20)). `chrome.webRequest` tồn tại **không** có nghĩa `net.observe` diễn đạt được. Câu này quyết định *hình dạng*, và lỗi hình dạng là lỗi đắt nhất vì publish rồi là breaking change.

**Câu hỏi thứ 4, chỉ cho trần: có cần đặc quyền không, hay chỉ là tính toán thuần?** Xem §3.0 — nó cắt được phần lớn chi phí của trần.

## 2. SÀN — kiểm kê delta đặc quyền

Trạng thái: ✅ đã có · **v1** đề xuất làm · ⏸ hoãn · ⛔ không bao giờ expose trần.

| Năng lực | Cơ chế | `GM_*` tương đương | Vì sao script không tự làm được | Kết luận |
|---|---|---|---|---|
| Fetch cross-origin dưới danh nghĩa extension | `fetch` trong background + `host_permissions` | `GM_xmlhttpRequest` | `fetch` ở USER_SCRIPT world chịu CORS của trang | ✅ **`net.request` ×match** — [net-request-host.ts](../src/adapters/browser-extension/module-registry/net-request-host.ts) |
| Lưu file xuống đĩa, đặt được tên | `chrome.downloads` | `GM_download` | Không có API nào trong trang | ✅ **`files.save`** — [files-save-host.ts](../src/adapters/browser-extension/module-registry/files-save-host.ts) |
| KV bền, riêng từng script | `chrome.storage` | `GM_setValue/getValue` | `localStorage` theo origin, user xoá được, mất khi đổi domain | ✅ `storage.rw` |
| Chạy code trong world JS của TRANG | `chrome.userScripts`/`scripting` world `MAIN` | `unsafeWindow` | USER_SCRIPT world cô lập với cả MAIN lẫn ISOLATED | **v1 · `page.eval`** — giá trị cao, rủi ro cao, phải đứng riêng một scope |
| Thông báo cấp OS | `chrome.notifications` | `GM_notification` | `Notification` API cần prompt riêng theo origin | **v1 · gộp vào `ui.render`** |
| Ghi clipboard không cần gesture | offscreen/background | `GM_setClipboard` | `navigator.clipboard` cần gesture + focus | **v1 · gộp vào `ui.render`** |
| Metadata script | — | `GM_info` | — | **v1 · `info`, không scope** (chỉ nói về chính script đó) |
| Menu lệnh | `chrome.contextMenus` | `GM_registerMenuCommand` | Không có | ⏸ **chặn bởi §4** (handler là function) |
| Mở tab | `chrome.tabs.create` | `GM_openInTab` | `window.open` có sẵn, chỉ vướng popup blocker | ⏸ **bỏ khỏi v1** — delta quá mỏng, không đáng một scope. Ghi vào Help: dùng `window.open` |
| Đọc/liệt kê tab khác | `chrome.tabs.query` | — | Không có | ⏸ Giám sát trá hình, chưa có use case. Không v1 |
| Cookie xuyên origin / httpOnly | `chrome.cookies` | `GM_cookie` | `document.cookie` theo origin, không thấy httpOnly | ⏸ Vector exfil trực tiếp. Chỉ cân nhắc kèm ×match, không v1 |
| Chạy nền khi trang đã đóng | `chrome.alarms` | — (TM không có) | Script chết theo trang | ⏸ Đòi khái niệm "script nền" — mô hình mới, không phải một API. Sau §12 |
| `@resource` / asset kèm script | — | `GM_getResourceText` | Script là 1 file | ⏸ Là tính năng của Studio (§12), không phải browser API |
| Phím tắt cấp trình duyệt | `chrome.commands` | — | Trang chỉ nghe được phím khi có focus | ⏸ Giá trị thấp |
| OAuth flow | `chrome.identity` | — | Popup blocker, redirect | ⏸ `secretRef` (Phase 5) phủ phần lớn nhu cầu |
| **CDP / debugger** | `chrome.debugger` | — | — | ⛔ God-capability. Chỉ lộ qua `net.mock` |
| **Rule mạng khai báo** | `chrome.declarativeNetRequest` | — | — | ⛔ Redirect được mọi thứ đi bất cứ đâu. Chỉ qua `net.mock` ×match |
| **Đăng ký script** | `chrome.userScripts`, `chrome.scripting` | — | — | ⛔ Script tự đăng ký script = tự leo thang, vòng qua consent |
| **Xin thêm quyền** | `chrome.permissions` | — | — | ⛔ Tự leo thang |
| **Quản lý extension / proxy / privacy** | `chrome.management`, `proxy`, `privacy` | — | — | ⛔ Không có use case, thảm hoạ nếu lạm dụng |
| **Offscreen** | `chrome.offscreen` | — | — | ⛔ Mechanism nội bộ. Chỉ lộ ra dưới dạng *kết quả* (remux, zip) |
| DOM, `fetch` cùng origin, IndexedDB, Worker, canvas… | — | — | Script có sẵn hết | ✅ `page.dom`/`page.fetch` — **disclosed**, không phải gate |

## 3. TRẦN — facade trên `features/`

### 3.0 Hai cơ chế giao hàng, không phải một

Đây là phần cắt được nhiều chi phí nhất, và nó **không hiển nhiên**: không phải mọi thứ ở trần đều cần đi qua RPC.

- **`lib.*` — thư viện tiêm thẳng vào world của script.** Tính toán thuần trên dữ liệu script *đã có trong tay*. Không RPC, không ranh giới clone, **không cần scope** (không có đặc quyền nào được trao — script tự làm được nếu chịu tự nhét thư viện vào, ta chỉ tiết kiệm công cho nó). Chi phí duy nhất: kích thước bundle trong mọi world.
- **`api.*` — RPC có scope.** Đặc quyền thật hoặc state sống ở background/offscreen.

**Bộ lọc trùng khớp gần như hoàn hảo với Layer 1 đã có**: [`sdk-layers`](../.claude/skills/sdk-layers/SKILL.md)'s litmus test cho `src/shared/` là *"sống sót được trong execution context khắt khe nhất"*. USER_SCRIPT world **chính là** một context như vậy. Nghĩa là phần lớn `src/shared/` đã đủ điều kiện làm `lib.*` theo cấu trúc, không cần viết lại — `media-manifest-parser`, `html-to-markdown`, `zip`, `media-magic-bytes`, `slugify`, `resolution-label`, `signed-url-detector`, `junk-url-patterns`.

Điều này giải luôn khoảng trống §12.4 từng ghi là chặn cứng — *"Readability + Turndown + zip phải do platform expose"* — mà **không tốn scope nào**.

> **Spike đã chạy — chọn "nhét tĩnh", đã xác nhận bằng browser thật (`test-lib-hls-parse.js` chạy sạch, không hỏi Grant).** Không phải nhét TEXT vào shim string như dự tính ban đầu — `chrome.userScripts.register`'s `js` là một MẢNG `ScriptSource[]` (`{code}` HOẶC `{file}`), y hệt `content_scripts.js`. Build `shared/media-manifest-parser.ts` qua `?script&iife` (đúng cơ chế `main-world-payload.page.ts` đã dùng) ra 1 file IIFE độc lập ([`user-script-lib-payload.ts`](../src/adapters/browser-extension/module-registry/user-script-lib-payload.ts)), rồi liệt kê nó làm `{file: libPayloadPath}` — entry ĐẦU trong mảng `js`, TRƯỚC `{code: shimmed}` — của MỌI script upload ([chrome-module-registry.ts](../src/adapters/browser-extension/module-registry/chrome-module-registry.ts)'s `registerUploadedScript`). Không cần `import()` động, không cần fetch text lúc runtime, không đụng câu hỏi CSP/world-boundary của `import()` — Chrome tự chạy các entry trong `js` THEO ĐÚNG THỨ TỰ, cùng 1 lượt thực thi (đảm bảo y hệt `content_scripts.js`, không phải giả định mới). Payload chỉ có đúng 1 side-effect quan sát được ra ngoài: `globalThis.__synapseLib = {...}` — shim ([user-script-shim.ts](../src/adapters/browser-extension/module-registry/user-script-shim.ts)) đọc rồi `delete` NGAY, y hệt pattern đã có của `__synapseModule` (bắt buộc, vì payload này được liệt kê lại ở MỌI script, world dùng chung nên mỗi script tự chạy lại 1 lượt riêng). Xác nhận được ở tầng build: output `.js` thật đúng hình dạng cần (1 IIFE, không `import`/`export`, đúng 1 câu gán global ở cuối) — **cái CHƯA xác nhận được là chạy thật trên `chrome.userScripts`**, cụ thể: `{file}` entry có thật sự resolve đúng file đã build (đường dẫn tương đối, content-hash đổi mỗi build) hay không, và thứ tự `[{file},{code}]` có giữ nguyên khi Chrome nạp cho USER_SCRIPT world (khác `MAIN` world `content_scripts` vốn đã có tiền lệ) hay không.
>
> **`ApiMethodDefinition.scope` đổi thành optional** ([kernel/scopes.ts](../src/kernel/scopes.ts)) để catalog được `lib.*` — trường hợp DUY NHẤT một method không có scope nào cả. `userscript-dts.ts`'s generator sửa theo (in "no scope required — pure computation" thay vì "requires `undefined`").
>
> **Cái từng CHƯA xác nhận được — resolve path của `{file}` + thứ tự `[{file},{code}]` trong USER_SCRIPT world thật — nay đã xác nhận.** `test-lib-hls-parse.js` chạy thành công và KHÔNG hỏi Grant lần nào (đúng thiết kế "no scope"), nghĩa là `globalThis.__synapseLib` đã sẵn sàng đúng lúc shim đọc nó — nếu thứ tự sai, script sẽ throw ngay khi gọi `ctx.api.lib.hls.parse` chứ không chạy sạch được. Còn lại chưa test: ≥2 script cùng active trên 1 trang có tranh chấp global này không (xem ROADMAP.md Open Points).

### 3.1 `media` — detect → inspect → download

Nội tại: `features/media/download/*.offscreen.ts` + `shared/download/` + `network-sniffer`. Toàn bộ đều truyền object sống (`OpfsRun`, `JobControl`, `AbortController`) ⇒ **không re-export được**, phải thiết kế facade id-based.

| API | Scope | Shape | Trạng thái |
|---|---|---|---|
| `lib.hls.parse(text, baseUrl)` | — | `parseM3u8` nguyên bản, đã thuần | ✅ Đã implement |
| `api.media.list()` | `media.*` | `Promise<DetectedMedia[]>` — data thuần, store đã có | Sẵn sàng |
| `api.media.inspect(url)` | `media.*` | `Promise<{variants, segments, encrypted, live}>` | Sẵn sàng (auto-inspect §6.3 đã làm việc này) |
| `api.media.download(opts)` | `media.*` | `→ Promise<jobId>` | Cần facade mới |
| `api.media.job(jobId)` | `media.*` | `→ {phase, done, total, error?}` — **polling** | Cần facade mới |
| `api.media.control(jobId, 'pause'\|'resume'\|'cancel'\|'stop-live')` | `media.*` | data thuần | Map thẳng vào `DownloadEngineCommand` đã có |
| ~~`api.media.onDetected(fn)`~~ | — | — | ⛔ chặn bởi §4 |

**Polling là lối thoát v1 hợp lệ, không phải giải pháp tạm.** `job(jobId)` né trọn vấn đề subscription, và engine vốn đã emit theo `phase` — chỉ cần giữ snapshot mới nhất theo `jobId`. Ghi rõ nhịp poll khuyến nghị trong Help.

### 3.2 `net.mock` — ca dễ nhất của cả trần — Đã implement, đã xác nhận trọn vẹn bằng browser thật (`add`/`list`/`remove` + interception thật sự trả fake response)

`MockConfig` ([shared/http-mock.ts](../src/shared/http-mock.ts)) **đã là data thuần, đã có validator, đã có test**. Không callback nào trong shape. Đây là API rẻ nhất và nên làm sớm hơn cảm giác trực giác.

- `ctx.api.net.mock.add(config) → {id}` · `.remove(id)` · `.list()`, scope `net.mock` ×match — [net-mock-host.ts](../src/adapters/browser-extension/module-registry/net-mock-host.ts).
- **`mechanism` do platform chọn, không do script khai — v1 CHỈ có `main-world`.** Script khai *muốn gì* (`endpointPattern`, `fakeStatus`, `fakeResponse`, `delayMs`); platform luôn chọn cơ chế rẻ nhất (`main-world`: patch `window.fetch`/XHR, không banner "đang debug tab", không tốn ngân sách rule của `declarativeNetRequest`). `action` cũng bị khoá cứng `'fake-response'` — không có `block`/`rewrite-request` ở v1 (script muốn hai cái đó, hoặc muốn thấy trong tab Network, vẫn phải dùng panel "HTTP Mock & Rewrite" của Management View bằng tay). Thu hẹp hơn bản nháp đầu (vốn định để platform CHỌN GIỮA cả 3 mechanism) — chọn cố định `main-world` xoá sạch toàn bộ ma trận ràng buộc chéo mechanism×action mà `validateMockConfig` đã phải mã hoá cho panel người dùng (`block` cần debugger/dnr, `dnr` không rewrite được method/body, …), đổi lấy việc script chưa `block`/`rewrite` được — ghi vào Chưa chốt bên dưới, không phải giấu đi.
- **Tái dùng NGUYÊN VẸN hạ tầng của panel "HTTP Mock & Rewrite"** ([http-error-mocker.background.ts](../src/adapters/browser-extension/features/http-mock/http-error-mocker.background.ts), cùng collection `MOCK_CONFIG_STORAGE_KEY`) thay vì dựng content-script/storage key thứ hai — payload MAIN-world đã áp mọi config `active` trong collection đó bất kể ai ghi, nên rule của script có hiệu lực ngay khi lưu, không cần cơ chế phát mới. Đánh đổi ghi rõ: tắt panel đó ở Management View là công tắc tổng, tắt luôn cả `net.mock` của mọi script (chỉ có 1 main-world script/1 bộ rule DNR/1 lần attach debugger cho cả extension) — `syncRegistration` export ra để `net-mock-host.ts` gọi lại sau mỗi `add`/`remove`, xem doc comment tại chỗ export.
- **`ownerModuleId`** (field mới trên `MockConfig`, [shared/http-mock.ts](../src/shared/http-mock.ts)) là ranh giới cách ly — `.list()`/`.remove()` lọc theo field này, không theo `id` suông, nên một script không bao giờ thấy/xoá được rule của script khác hay rule người dùng tự tạo tay ở Management View. `validateMockConfig` phải biết copy field này qua mỗi lần save — nếu không, sửa 1 rule do script tạo bằng tay ở Management View (form không có field này nhưng `{...existing}` đã mang nó theo) sẽ âm thầm "mất chủ", y hệt bug lớp `matchCount` từng phải né.
- **Kiểm tra `match` chỉ ở `mock.add`, KHÔNG ở `mock.remove`/`mock.list`.** `net.mock` là `requiresMatch: true` nhưng chỉ `add` có `resourceUrl` (chính `endpointPattern`) — `remove`/`list` không đọc/tạo tài nguyên mới, chúng chỉ đụng cái script đã tự tạo (đã bị `match` chặn đúng lúc `add`). Bắt `grantsAllow` generic đòi `resourceUrl` cho cả hai sẽ khoá chết `.list()`/`.remove()` vĩnh viễn (không có URL nào để trích từ 1 cái `id`). Giải bằng field mới `ApiMethodDefinition.matchExempt` ([kernel/scopes.ts](../src/kernel/scopes.ts)) — method nào gắn cờ này thì `rpc-handler.ts` chỉ đòi "scope có được cấp không", bỏ qua `resourceUrl`; ranh giới thật vẫn là `ownerModuleId` ở tầng host function, không phải `match`.
- **`endpointPattern` phải có scheme+host CỤ THỂ, chỉ path được dùng `*`.** Kiểm tra `match` tái dùng NGUYÊN `resourceUrlForCall`/`grantsAllow`/`matchesUrlPattern` đã có cho `net.request` — tận dụng bằng cách coi `endpointPattern` như một URL thật rồi kiểm nó có rơi vào `match` đã cấp hay không. `matchesUrlPattern` gọi `new URL()` trên đó, nên một pattern có wildcard ở scheme/host (`*://*.example.com/*`) sẽ ném lỗi parse ⇒ bị từ chối (an toàn, đóng cửa) — hạn chế thật của v1, không phải bug; script muốn intercept nhiều subdomain vẫn phải khai từng domain cụ thể trong `endpointPattern`.
- **`rpc-handler.ts`'s dispatch giờ đi được method có dấu chấm** (`resolveMethodHandler`, tách khỏi cách đọc `namespace[method]` phẳng cũ) — `net.mock.add/remove/list` là entry ĐẦU TIÊN trong `API_METHODS` có `method` chứa `.` VÀ `transport: 'rpc'` thật (khác `lib.hls.parse`, vốn cũng có dấu chấm nhưng `transport: 'in-world'` nên chưa bao giờ chạm dispatch này). Generalize một lần thay vì đặc cách riêng `net.mock`.
- **Script KHÔNG tự quan sát được mock của chính nó qua `fetch()` của chính nó.** `main-world` patch `window.fetch` ở world MAIN của TRANG; script upload chạy ở world USER_SCRIPT — dùng chung DOM với trang nhưng KHÔNG dùng chung global JS (`page.dom`/`page.fetch`'s "disclosed" framing đã ngầm giả định điều này nhưng chưa ai viết thẳng ra cho `net.mock`). Hệ quả: `fetch(...)` gọi TỪ TRONG script upload luôn là `fetch` thật, chưa patch — verify sai cách này ăn ngay 1 lỗi CORS thật (bắt được ở lượt test đầu: script gọi `fetch('https://example.com/...')` từ trang `angular.dev`, dính `blocked by CORS policy`, KHÔNG phải bug của `net.mock`). Cách verify đúng: đọc kết quả qua traffic THẬT của trang (trang tự fetch endpoint đó), hoặc chạy tay `fetch(...)` từ console của chính TRANG (world MAIN mặc định của DevTools), không phải console/world của script. Đã sửa [`docs/examples/test-net-mock.js`](../docs/examples/test-net-mock.js) và [user-scripts.md](user-scripts.md#faking-network-responses) theo hướng này.
- **Bug thật bắt được ở lượt browser-test đầu (không phải lỗi ở trên): `document is not defined` ngay lần gọi `add()` đầu tiên** — nguyên nhân không phải logic `net.mock` mà là `net-mock-host.ts` dùng dynamic `import()` để né vấn đề test-import tĩnh, và Vite tự bọc MỌI dynamic import bằng helper đụng `document` — kéo thẳng vào bundle SERVICE WORKER (không có `document`). Đã vá bằng quay lại import tĩnh + `vi.mock()` riêng cho test; chi tiết đầy đủ ở [`docs/LESSONS.md`](LESSONS.md#bundler-viterollup-giả-định-môi-trường-có-dom).
- **User đã xác nhận bằng Chrome thật (trang `angular.dev`): sau reload 1 lần để kích hoạt interceptor, `fetch(...)` gọi từ console THẬT của trang (dropdown `top`) trả đúng `{hello: "from synapse"}`, không lỗi CORS.** `net.mock` coi như xong trọn vẹn ở mục 5 — implement + browser-verify, không còn treo. Manual test: [`docs/examples/test-net-mock.js`](../docs/examples/test-net-mock.js).

### 3.3 `net.observe` — chặn cứng, có đường vòng

Subscription không qua được clone (§4). Đường vòng dùng đúng thứ đã có: observer `webRequest` vốn đã ghi vào store ⇒ **`api.net.recent({since, filter})`** trả ring buffer. Kém hơn subscription về độ trễ, nhưng chạy được ngay và không hứa quá.

### 3.4 `page.extract` — reader mode — Đã implement (`lib.readable`/`lib.toMarkdown`/`lib.zip`), đã xác nhận bằng browser thật

Gần như toàn bộ là **`lib.*`, không phải `api.*`**: Readability + Turndown chạy trên `document` mà script đang cầm sẵn.

- `lib.readable(doc?) → {title, root, text} | undefined` · `lib.toMarkdown(root, {baseUrl, resolveImageUrl?}) → string` · `lib.zip(entries) → Uint8Array` — **không scope nào cả**. Trả `root: Element` (Node thật), không phải `html: string` như bản nháp đầu — khác `net.request`/`net.mock`, `lib.*` không đi qua ranh giới clone nên không có lý do phải serialize ra string rồi bắt caller reparse.
- **`lib.readable` MUTATE `doc` nó nhận** (đặc tính gốc của Readability) — omit `doc` thì tự `document.cloneNode(true)` trước, y hệt `reader-mode-converter.module.ts`'s `load-dom` step, để lệnh "đọc trang" không vô tình sửa trang thật user đang xem.
- **Nơi đặt: `module-registry/`, không phải `shared/`.** `lib.readable`'s wrapper ([lib-readable.ts](../src/adapters/browser-extension/module-registry/lib-readable.ts)) đọc global `document` khi `doc` bị omit — vi phạm quy ước "không tự đọc global" của Global SDK (`shared/`, xem doc comment của `html-to-markdown.ts`), nên sống ở tầng Environment SDK thay vì `shared/`. `parseM3u8`/`htmlToMarkdown`/`buildZip` tự thân vẫn nguyên bản từ `shared/`, không viết lại.
- **`kernel/service-injector.ts`'s stand-in-context stub là ngoại lệ duy nhất không có `readable` thật** — `kernel/` không được phép phụ thuộc `module-registry/` (Adapter layer), nên fallback (chỉ dùng khi test Kernel/Adapter quên wire factory) dùng `failSync` cho riêng `readable`, còn `hls.parse`/`toMarkdown`/`zip` vẫn thật (cả ba nằm ở `shared/`, kernel import thẳng được, không phạm layering).
- Phần cần đặc quyền chỉ còn: tải ảnh cross-origin (⇒ `net.request`) và lưu file (⇒ `files.save`). Cả hai đã nằm ở **sàn**, đã implement.
- **Chi phí đo được của "nhét tĩnh" (§3.0), giờ có số thật**: payload build ra 49.85KB sau khi gộp Readability+Turndown+zip+parseM3u8 (từ 1.8KB lúc chỉ có `hls.parse`) — mỗi script upload cõng thêm ngần đó, đúng đánh đổi đã ghi nhận trước khi biết con số. Chưa đủ lớn để cân nhắc lại hướng, nhưng là dữ kiện cần nhớ nếu `lib.*` phình thêm nhiều thư viện nữa.
- **Hệ quả**: template `reader-mode-converter` của §12.4 dày lên gần bằng builtin **chỉ nhờ sàn + `lib.*`**, không cần một API trần nào — xem [`docs/examples/test-lib-reader-mode.js`](../docs/examples/test-lib-reader-mode.js), bài kiểm tra thật đầu tiên cho chiến lược 2 trục. **User đã xác nhận bằng Chrome thật**: chạy trọn `lib.readable`→`lib.toMarkdown`→`net.request`(ảnh)→`lib.zip`→`files.save`, mở `.zip` tải về ra đúng `article.md` đọc được + `images/` có ảnh mở được, không hỏng byte.

Riêng crawl site (discovery qua robots/sitemap, cap 200 trang) là **policy nghiệp vụ**, không phải năng lực. Để nguyên trong builtin; template chỉ cần vài chục dòng `for` là đủ dạy đúng shape.

## 4. Chặn cứng chung: subscription — thiết kế MỘT lần

`api.x.onY(handler)` không tồn tại được: function không qua structured clone và **im lặng biến thành `undefined`** — đúng lớp lỗi `needs:['net'|'dom']` no-op mà cả mô hình scope dựng ra để diệt.

Ảnh hưởng tới: `net.observe`, progress của `media.download`, `contextMenus`, và mọi thứ event-driven về sau. **Ba mục, một bài toán — giải một lần.**

Ba đường, chưa chốt:

| Đường | Cách | Đánh đổi |
|---|---|---|
| **Polling** | `job(id)` / `recent({since})` | Rẻ nhất, chạy được ngay, không hạ tầng mới. Trễ + tốn nhịp rỗng |
| **Long-lived port** | `chrome.runtime.connect` | Đúng cơ chế, nhưng port từ USER_SCRIPT world **chưa verify** — và §11.3 đã dạy: đường messaging của user script không giống đường của content script (`onUserScriptMessage` vs `onMessage`). Phải test browser thật TRƯỚC |
| **Đăng ký local** | Shim giữ handler trong world của script; RPC chỉ mang *tín hiệu* qua | Đã ghi sẵn trong doc comment của [synapse-api.ts](../src/kernel/synapse-api.ts#L18): *"Subscriptions must register their handler locally in the caller's own world"* — tức đây là đường đã được chọn về nguyên tắc, chỉ chưa hiện thực |

**Đề xuất: v1 dùng polling cho cả `media` lẫn `net`, và spike đường 3 riêng.** Không treo Phase 5 vào một spike chưa chạy.

## 5. Đếm scope — chốt trước khi code method thứ 30

Trần là **~10** ([scopes.ts:19](../src/kernel/scopes.ts#L19)): quá đó user bấm Allow hết và mô hình sụp. Đếm thô cả hai trục ra **~13** ⇒ phải gộp *có chủ đích*, không phải phát hiện lúc đang code.

**Nguyên tắc gộp: giảm chiều SỐ LƯỢNG bằng chiều TÀI NGUYÊN.** Ràng buộc (B) đã có sẵn — `net.request` + `match: ['*://api.openai.com/*']` giới hạn thiệt hại tốt hơn nhiều so với chẻ nó thành ba scope hẹp mà cái nào cũng cho phép mọi miền.

Catalog đề xuất — **8 enforced + 2 disclosed**:

| Scope | Loại | ×match | Gộp những gì | Trục |
|---|---|---|---|---|
| `storage.rw` ✅ | enforced | — | | sàn |
| `net.request` ✅ | enforced | **bắt buộc** | fetch cross-origin dưới danh nghĩa extension | sàn |
| `files.save` ✅ | enforced | — | ghi file xuống đĩa | sàn |
| `page.eval` | enforced | — | chạy code trong world JS của trang (`unsafeWindow`) | sàn |
| `ui.render` | enforced | — | UI nổi (Phase 3) + notification + clipboard + (menu, khi §4 thông) | sàn |
| `media.*` | enforced | — | list + inspect + download + control | trần |
| `net.mock` | enforced | **bắt buộc** | thêm/xoá/liệt kê rule | trần |
| `net.observe` | enforced | **bắt buộc** | đọc traffic đã quan sát | trần |
| `page.dom` ✅ | disclosed | — | | — |
| `page.fetch` ✅ | disclosed | — | | — |
| `lib.*` | **không scope** | — | mọi tính toán thuần (§3.0) | trần |

Hai quyết định gộp cần ghi rõ vì chúng gây tranh cãi:

- **`media.read` + `media.download` gộp làm một.** Tách ra tạo một nghi thức 2-prompt mà gần như 100% user sẽ Allow cả hai (ai cho phép dò media cũng muốn tải) — đúng loại nghi thức rỗng §12.0 đã bác.
- **`tabs.open` bỏ hẳn khỏi v1.** `window.open` đã có trong world của script; delta đặc quyền chỉ là popup blocker. Không đáng 1/10 ngân sách scope.

## 6. Thứ tự đề xuất

Sắp theo *giá trị mở khoá / chi phí*, không theo thứ tự bảng.

1. **`net.request` ×match — Đã implement, đã xác nhận bằng browser thật.** [`shared/match-pattern.ts`](../src/shared/match-pattern.ts) (matcher scheme/host/path đúng chuẩn Chrome match pattern, KHÔNG dùng lại `endpointPatternToRegexSource` của `http-mock.ts` — glob substring đó thiếu cấu trúc host, `*.evil.com*example.com*` sẽ khớp nhầm `example.com.evil.com`). `grantsAllow` (`kernel/scopes.ts`) nhận thêm tham số `resourceUrl` tuỳ chọn — scope `requiresMatch` mà thiếu `resourceUrl` là **từ chối** (fail-closed), không phải cho qua; `ApiMethodDefinition` thêm field `resourceUrl` (hàm rút URL từ `args`) để `rpc-handler.ts` không cần biết hình dạng tham số riêng của từng namespace. `net-request-host.ts` (`module-registry/`, cùng vị trí với `script-storage.ts` — tiền lệ 1 backing-file/scope) chạy `fetch` thật trong background, cap timeout 120s + response 25MB, convention `bodyEncoding: 'utf8'|'base64'` y hệt `http-mock.ts` (§2.6.1). User đã verify trên Chrome thật qua đường uploaded-script: upload → Grant (consent line hiện đúng domain) → `ctx.api.net.request` trả `200 text/html`; đổi URL ra ngoài `match` mà không re-grant → bị từ chối đúng tại call site, không hang/không pass nhầm (chi tiết ở [ROADMAP.md §11.6](ROADMAP.md#116-phase-5--mở-api-surface-thật--bắt-đầu-netrequest-xong-còn-lại-là-kế-hoạch)).
2. **`files.save` — Đã implement, chưa verify bằng browser thật.** [`files-save-host.ts`](../src/adapters/browser-extension/module-registry/files-save-host.ts) ship `data:` URL thẳng vào `chrome.downloads.download` — KHÔNG đi qua đường `Blob`+`URL.createObjectURL`+relay-sang-background mà `output.offscreen.ts` cần (đường đó tồn tại CHỈ vì Offscreen Document thiếu `chrome.downloads` và blob: URL chỉ sống trong đúng document đã tạo nó — hàm này chạy thẳng trong background, đã có cả hai thứ đó cùng lúc, nên không có context thứ hai nào cần relay tới). Không `×match` (file ghi ra không tự exfiltrate được, khác `net.request`). **Bug tự bắt được lúc viết test, không phải sau khi ship**: cap kích thước ban đầu đặt SAU bước base64-encode (`bytesToBase64` của `blob-store.ts` là vòng lặp JS từng byte một, không phải hàm native) — test cap 25MB mất 2.8s vì nội dung bị encode xong xuôi rồi mới bị từ chối, cap không hề chặn được phần việc tốn thời gian. Vá bằng tách `contentByteLength` (đo qua `TextEncoder.encode`/`atob` — cả hai native, nhanh) ra khỏi bước encode thật, kiểm cap TRƯỚC, chỉ encode khi đã lọt qua; hạ cap xuống 10MB (khớp cap ảnh ~10MB/ảnh đã có, không phải 25MB của `net.request` — lý do khác nhau: `net.request` chỉ base64 khi `responseType:'arraybuffer'` là tuỳ chọn, `files.save` base64 hoá ở NHÁNH MẶC ĐỊNH `utf8`). Cùng với (1) là đủ cho template reader-mode chạy thật.
3. **Spike `lib.*` (§3.0) — Đã implement (`lib.hls.parse`), chưa verify bằng browser thật.** Chọn "nhét tĩnh" qua `{file}` entry, không phải `import()` động — xem chi tiết ở §3.0. Chỉ 1 hàm (`parseM3u8`) làm proof-of-concept, cố tình chưa port cả danh sách `shared/` liệt kê ở đầu §3.0 (Turndown/zip/magic-bytes/...) — đó là việc của mục 4 khi cần, mở khoá tương tự (thêm 1 dòng vào `user-script-lib-payload.ts`'s object, không phải cơ chế mới).
4. **Template `reader-mode` (§12.4) — Đã implement dưới dạng test script, đã xác nhận bằng browser thật.** [`docs/examples/test-lib-reader-mode.js`](../docs/examples/test-lib-reader-mode.js) dùng ĐÚNG (1)+(2)+(3), không API trần nào — xác nhận đúng như dự đoán. Chưa phải template CHÍNH THỨC theo nghĩa §12.4 (chưa có cơ chế `examples/` + `import.meta.glob` phục vụ trong Studio — đó là việc của §12, chưa tới lượt); đây là bản test thủ công đi trước để CHỨNG MINH API đủ dùng trước khi đầu tư vào hạ tầng serve-template.
5. **`net.mock` — Đã implement, đã xác nhận trọn vẹn bằng browser thật.** `add`/`remove`/`list`, luôn `mechanism: 'main-world'` + `action: 'fake-response'` (platform chọn, script không được chọn — xem §3.2 để biết vì sao thu hẹp so với bản nháp "platform chọn giữa cả 3 mechanism"). Tái dùng nguyên collection + payload MAIN-world của panel "HTTP Mock & Rewrite" builtin, cách ly theo script bằng `ownerModuleId` mới trên `MockConfig`. Mở khoá hai thứ tái dùng được về sau: `ApiMethodDefinition.matchExempt` (method đụng tài nguyên đã tạo trước đó, không phải tài nguyên mới, nên bỏ qua kiểm `match` per-call) và `rpc-handler.ts` dispatch theo method có dấu chấm (`mock.add` là RPC method có dấu chấm đầu tiên — trước đó chỉ `lib.*` có dấu chấm nhưng toàn `in-world`). User xác nhận trên `angular.dev`: `add()` → reload 1 lần (kích hoạt `chrome.scripting.registerContentScripts`, không retroactive cho tab đang mở) → `fetch()` từ console thật của trang trả đúng fake response, không CORS.
6. **`media.*`** với `job()` polling — facade id-based, phần việc lớn nhất.
7. **`page.eval`** — giá trị cao, cần thiết kế consent riêng vì nó phá vỡ cô lập world.
8. **Spike subscription** (§4) → nếu xanh, nâng `net.observe` và progress `media` lên push.

## 7. Chưa chốt

- Cơ chế tiêm `lib.*` (§3.0) — chờ spike.
- Hình dạng subscription (§4) — chờ spike; v1 đi polling.
- `page.eval` có cần ×match không (chạy code trong trang nào?) — nghiêng về **có**.
- `chrome.cookies`, `chrome.alarms` (script nền), `@resource` — cả ba đòi khái niệm mới chứ không chỉ một method; chưa vào plan.
- **`net.mock`'s `block`/`rewrite-request` cho script (§3.2)** — v1 chỉ `fake-response`. Mở ra đòi hoặc (a) để script tự chọn giữa `main-world`/`debugger` (đổi ngược quyết định "platform chọn, script không chọn" — banner "đang debug tab" khi đó bị BẬT bởi một script, chưa rõ có nên) hoặc (b) platform tự suy ra mechanism cần thiết từ action (rewrite cần method/body thì bắt buộc `debugger`, v.v.) — mỗi hướng đều cần thiết kế riêng, chưa chọn.
- **`net.mock` bị khoá chung công tắc với panel "HTTP Mock & Rewrite" builtin (§3.2)** — tắt panel đó ở Management View tắt luôn interception của mọi script đang dùng `net.mock`, vì dùng chung 1 main-world script/1 bộ DNR rule/1 lần attach debugger cho cả extension. Tách hạ tầng riêng cho scripted rules (content script + storage key thứ hai) sẽ gỡ được, nhưng chưa đáng làm cho tới khi có use case thật đụng phải.
