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
| Fetch cross-origin dưới danh nghĩa extension | `fetch` trong background + `host_permissions` | `GM_xmlhttpRequest` | `fetch` ở USER_SCRIPT world chịu CORS của trang | **v1 · `net.request` ×match** — ưu tiên số 1 |
| Lưu file xuống đĩa, đặt được tên | `chrome.downloads` | `GM_download` | Không có API nào trong trang | **v1 · `files.save`** |
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

> **Spike bắt buộc trước khi cam kết**: cách tiêm. Nhét tĩnh vào shim là đơn giản nhất nhưng cộng size vào mọi script; `import()` động một URL `chrome-extension://` từ USER_SCRIPT world thì chưa biết có qua được CSP/world boundary không. Cùng lớp rủi ro với spike Monaco (§12.0) — **không viết tính năng nào phụ thuộc `lib.*` trước khi spike xanh**.

### 3.1 `media` — detect → inspect → download

Nội tại: `features/media/download/*.offscreen.ts` + `shared/download/` + `network-sniffer`. Toàn bộ đều truyền object sống (`OpfsRun`, `JobControl`, `AbortController`) ⇒ **không re-export được**, phải thiết kế facade id-based.

| API | Scope | Shape | Trạng thái |
|---|---|---|---|
| `lib.hls.parse(text)` | — | `parseM3u8` nguyên bản, đã thuần | Sẵn sàng sau spike §3.0 |
| `api.media.list()` | `media.*` | `Promise<DetectedMedia[]>` — data thuần, store đã có | Sẵn sàng |
| `api.media.inspect(url)` | `media.*` | `Promise<{variants, segments, encrypted, live}>` | Sẵn sàng (auto-inspect §6.3 đã làm việc này) |
| `api.media.download(opts)` | `media.*` | `→ Promise<jobId>` | Cần facade mới |
| `api.media.job(jobId)` | `media.*` | `→ {phase, done, total, error?}` — **polling** | Cần facade mới |
| `api.media.control(jobId, 'pause'\|'resume'\|'cancel'\|'stop-live')` | `media.*` | data thuần | Map thẳng vào `DownloadEngineCommand` đã có |
| ~~`api.media.onDetected(fn)`~~ | — | — | ⛔ chặn bởi §4 |

**Polling là lối thoát v1 hợp lệ, không phải giải pháp tạm.** `job(jobId)` né trọn vấn đề subscription, và engine vốn đã emit theo `phase` — chỉ cần giữ snapshot mới nhất theo `jobId`. Ghi rõ nhịp poll khuyến nghị trong Help.

### 3.2 `net.mock` — ca dễ nhất của cả trần

`MockConfig` ([shared/http-mock.ts](../src/shared/http-mock.ts)) **đã là data thuần, đã có validator, đã có test**. Không callback nào trong shape. Đây là API rẻ nhất và nên làm sớm hơn cảm giác trực giác.

- `api.net.mock.add(config) → id` · `.remove(id)` · `.list()`, scope `net.mock` ×match.
- **`mechanism` do platform chọn, không do script khai.** Script khai *muốn gì* (`action`, `match`), platform chọn `dnr`/`main-world`/`debugger`. Lý do: `debugger` bật banner "đang debug tab" toàn cục — một script không được quyền áp cái đó lên cả trình duyệt của user. Script chỉ được nêu *hint* (vd "cần thấy trong Network tab").

### 3.3 `net.observe` — chặn cứng, có đường vòng

Subscription không qua được clone (§4). Đường vòng dùng đúng thứ đã có: observer `webRequest` vốn đã ghi vào store ⇒ **`api.net.recent({since, filter})`** trả ring buffer. Kém hơn subscription về độ trễ, nhưng chạy được ngay và không hứa quá.

### 3.4 `page.extract` — reader mode

Gần như toàn bộ là **`lib.*`, không phải `api.*`**: Readability + Turndown chạy trên `document` mà script đang cầm sẵn.

- `lib.readable(doc?) → {title, html, text}` · `lib.toMarkdown(html, {baseUrl}) → string` · `lib.zip(files) → Blob` — **không scope nào cả**.
- Phần cần đặc quyền chỉ còn: tải ảnh cross-origin (⇒ `net.request`) và lưu file (⇒ `files.save`). Cả hai đã nằm ở **sàn**.
- **Hệ quả**: template `reader-mode-converter` của §12.4 dày lên gần bằng builtin **chỉ nhờ sàn + `lib.*`**, không cần một API trần nào. Đây là ca kiểm chứng tốt nhất cho toàn bộ chiến lược 2 trục — nên làm nó **đầu tiên** sau khi có `net.request`.

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
| `net.request` | enforced | **bắt buộc** | fetch cross-origin dưới danh nghĩa extension | sàn |
| `files.save` | enforced | — | ghi file xuống đĩa | sàn |
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

1. **`net.request` ×match** — mở khoá nhiều nhất trên mỗi dòng code. Không phụ thuộc gì, không chặn bởi §4.
2. **`files.save`** — nhỏ, và cùng với (1) là đủ cho template reader-mode chạy thật.
3. **Spike `lib.*`** (§3.0) — quyết định cơ chế tiêm. Xanh thì `lib.*` gần như miễn phí vì `shared/` đã đúng shape.
4. **Template `reader-mode` (§12.4)** — bài kiểm tra thật đầu tiên cho chiến lược 2 trục: nếu (1)+(2)+(3) đúng thì template này dày lên mà không cần một API trần nào.
5. **`net.mock`** — rẻ nhất của trần (`MockConfig` đã là data thuần, đã có test).
6. **`media.*`** với `job()` polling — facade id-based, phần việc lớn nhất.
7. **`page.eval`** — giá trị cao, cần thiết kế consent riêng vì nó phá vỡ cô lập world.
8. **Spike subscription** (§4) → nếu xanh, nâng `net.observe` và progress `media` lên push.

## 7. Chưa chốt

- Cơ chế tiêm `lib.*` (§3.0) — chờ spike.
- Hình dạng subscription (§4) — chờ spike; v1 đi polling.
- `page.eval` có cần ×match không (chạy code trong trang nào?) — nghiêng về **có**.
- `chrome.cookies`, `chrome.alarms` (script nền), `@resource` — cả ba đòi khái niệm mới chứ không chỉ một method; chưa vào plan.
