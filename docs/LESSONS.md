# Lessons Learnt

Sổ tay các gotcha/bài học kỹ thuật rút ra khi implement Synapse — không phải build spec, không phải trạng thái tính năng (xem [ROADMAP.md](ROADMAP.md) cho việc đó). Mục đích: tránh mất công lặp lại đúng cái bẫy đã từng rơi vào. Skills nên trỏ về đây khi gặp vấn đề thuộc đúng khu vực thay vì lặp lại nội dung.

## MV3 message passing / relay

- **`chrome.runtime.sendMessage` là BROADCAST, không phải gửi có đích danh.** Một relay forward message bằng cách gửi lại ĐÚNG type nó vừa nhận sẽ bị chính message gốc đó phát tới listener cuối một lần nữa nếu listener cuối cũng nghe đúng type gốc → xử lý trùng lặp (từng gây `OPFS InvalidStateError` do hai lần `createWritable()` đụng nhau). Luôn tách hẳn type client-facing khỏi type relay-nội-bộ (vd `synapse:download-engine-command` vs `...-command-relayed`).
- **Một listener không có type/shape guard sẽ `sendResponse` cho MỌI message service worker nhận được** — kể cả message không phải của nó — và có thể THẮNG race trả lời trước response thật (Chrome chỉ nhận `sendResponse` đầu tiên gọi tới). Luôn guard theo field bắt buộc (vd `if (!message?.workflowId) return;`) trước khi gọi `sendResponse`/xử lý.
- **Offscreen Document chỉ có đúng MỘT API mở rộng dùng được: `chrome.runtime`.** Mọi `chrome.*` khác (`storage`, `downloads`, `declarativeNetRequest`, ...) đều `undefined` ở context này — không phải giới hạn permission, là giới hạn cứng của context. Phải relay qua `background/index.ts` (nơi duy nhất có đủ `chrome.*`). Một `.catch(() => undefined)` bọc quanh lời gọi `chrome.storage...` sẽ nuốt êm lỗi này — không crash, chỉ âm thầm cho kết quả rỗng/sai, rất khó phát hiện (từng khiến header-replay vô hiệu hoá hoàn toàn nhiều tuần không ai để ý). Luôn `console.error` nguyên object lỗi ở mọi catch cấp cao trong code chạy ở Offscreen Document.
- **`ensureOffscreenDocument()` phải cache promise đang tạo** — `chrome.offscreen.createDocument` ném lỗi nếu gọi lần 2 trước khi lần 1 resolve (chỉ 1 offscreen document/extension).

## `chrome.sidePanel`

- **`chrome.sidePanel.open()` bắt buộc gọi ĐỒNG BỘ, không `await` gì trước nó, trong đúng tick xử lý message.** User-gesture đi kèm qua `chrome.runtime.sendMessage` từ content-script click handler hết hạn chỉ sau một microtask — thêm `await chrome.sidePanel.setOptions(...)` (dù chỉ để "chuẩn bị state") ngay trước `open()` sẽ đổi lỗi "No active side panel for tabId" thành "may only be called in response to a user gesture". Dùng `.catch()`, không `await`.
- **`chrome.sidePanel.setOptions({enabled:true})` KHÔNG kèm `path` gọi tràn lan trên MỌI tab** (kể cả tab chưa từng liên quan) sẽ tự phá state side-panel của tab đó → "No active side panel for tabId" dù chưa từng gọi `open()` sai chỗ nào. Chỉ tác động các tab mà chính logic của mình đã từng disable (theo dõi qua một Set id, dọn theo `chrome.tabs.onRemoved`).

## DNR (`declarativeNetRequest`)

- **`condition.tabIds` chỉ được hỗ trợ cho rule SESSION-scoped, không phải dynamic rule.** Cần cho case "chỉ áp rule lên request tự extension phát ra" (header replay) qua `tabIds:[chrome.tabs.TAB_ID_NONE]`.
- **`TAB_ID_NONE` (-1) không cover fetch của một EXTENSION PAGE chạy trong tab thật** (vd Tab Merge cũ) — trang đó có tabId dương, rule với `tabIds:[TAB_ID_NONE]` sẽ im lặng không match (không lỗi gì, chỉ request đi ra không đổi). Cần thêm `chrome.tabs.getCurrent()`'s id vào `tabIds` cho caller chạy trong tab thật. Đây là lý do chuyển engine sang Offscreen Document (§8.1 ROADMAP) đơn giản hoá được — Offscreen Document không gắn tab nên rơi đúng vào `TAB_ID_NONE` mặc định, không cần "self-tab-id" logic riêng nữa.
- **Một rule = một action.** Redirect và modifyHeaders phải tách 2 rule dùng chung condition, không gộp một rule đa hành vi.
- **`web_accessible_resources` không tự động cho asset build thường** — asset Vite emit dưới `assets/` (content-hash tên file) phải khai tay `{resources:['assets/*'], matches:[...]}` theo pattern, không theo tên file cụ thể.

## Job control: Pause/Resume/Cancel dưới pool song song

- **Đếm "đang chạy" (`inFlight`) phải tính theo TRỌN VÒNG ĐỜI một item đã claim (fetch + mọi side-effect như ghi file), không chỉ theo fetch attempt.** Nếu giảm `inFlight` ngay khi fetch xong (trước khi ghi OPFS xong, việc ghi lại đi qua hàng đợi bất đồng bộ riêng) thì item cuối cùng có thể ghi xong SAU khi đã emit `'paused'` → phát `'segments'` đè `'paused'` → nút Pause không bao giờ kịp lật sang Resume. Bọc `inFlight++`/`--` quanh đúng phạm vi "từ lúc claim tới lúc mọi side-effect của item đó xong", không phải quanh mỗi network attempt.
- **Đếm theo attempt (không phải theo item) lại là bẫy ngược cho code có retry-tự-check-pause-giữa-các-lần-thử của chính nó** — một item đang kẹt "chờ resume để retry" sẽ giữ `inFlight>0` mãi mãi nếu đếm bao gồm cả khoảng chờ đó, tự deadlock (`'pausing'` không bao giờ thành `'paused'`).
- **CANCEL phải set cờ `cancelled=true` ĐỒNG BỘ TRƯỚC KHI** gọi `AbortController.abort()`. Worker bắt lỗi từ abort phải kiểm tra cờ này để `return` (không `throw`) — giữ bất biến "`Promise.all` chỉ resolve sạch khi cancel thật, reject khi lỗi mạng thật". Nếu không, không phân biệt được "worker dừng vì bị huỷ" với "worker dừng vì lỗi thật".
- **Một relay/UI reflect state qua nhiều bước (pausing→paused) cần trạng thái trung gian trung thực** — đừng emit "đã dừng" ngay khi lệnh được gửi nếu vẫn còn việc đang chạy dở; UI nói dối kiểu này tự nó tạo ra bug tiếp theo (nút không lật đúng, vì mất window hiển thị đúng chỉ tồn tại một nhịp render trước khi bị ghi đè).

## Rendering không-diff (VanJS-style)

- **Một renderer phá-sạch-dựng-lại toàn bộ cây DOM mỗi lần gọi (không diff) sẽ nhấp nháy và RỚT CLICK nếu bị gọi ở tần suất cao** (event tiến độ bắn nhiều lần/giây từ engine tải file) — node cũ có thể bị gỡ khỏi DOM đúng lúc trình duyệt định gửi sự kiện click cho nó. Gộp nhiều yêu cầu render trong cùng một khoảng ngắn qua `requestAnimationFrame` (coalesce thành đúng 1 lần render/frame) — không phải bug ở tầng logic, chỉ là tần suất render phía UI.

## OPFS / ffmpeg.wasm

- **`ffmpeg.writeFile` copy byte vào MEMFS = heap WebAssembly, giữ nguyên tới hết lượt chạy.** Staging dữ liệu ở IndexedDB rồi xoá blob ngay sau `writeFile` KHÔNG giải quyết OOM — chỗ tốn RAM thật là bên trong wasm heap (~4GB trần cho wasm32), không phải mảng JS giữ byte. Muốn xử lý file lớn (>1-2GB) phải tránh `writeFile` per-segment hoàn toàn: `ffmpeg.mount(FFFSType.WORKERFS, {files:[file]})` đọc thẳng một `File` file-backed (từ OPFS) mà không copy vào MEMFS phía input.
- **`FileSystemWritableFileStream.write({type:'write', position, data})` hỗ trợ ghi theo offset tuỳ ý** — không bắt buộc phải append tuần tự. Cần cho ghi không-theo-thứ-tự-tải-về (pool song song) hoặc multi-connection range downloader.
- **`InvalidStateError: state had changed since it was read from disk` có thể sống sót qua remove/reload extension, chỉ hết khi restart hẳn browser** — dấu hiệu đây là khoá cấp thấp gắn với storage bucket của Chromium, không phải thứ JS tạo ra hay có toàn quyền giải phóng. Không sửa được tận gốc từ JS; giảm thiểu bằng cách quét-xoá mọi file mồ côi (`sweepStaleOpfsRuns`) ngay khi một Offscreen Document MỚI khởi động (an toàn tuyệt đối vì MV3 chỉ cho 1 offscreen document/extension — file còn sót chỉ có thể thuộc document đã chết). Phải `await` sweep xong TRƯỚC KHI xử lý lệnh đầu tiên, nhưng KHÔNG await nó trước khi đăng ký listener (tránh mất message tới sớm).
- **`FileSystemDirectoryHandle.keys()`/`values()`/`entries()` thiếu trong `lib.dom.d.ts` bundled của TypeScript** dù mọi trình duyệt hỗ trợ OPFS đều có — cần tự `declare global` augment.
- **Resume sau crash: không tin mù checkpoint đã lưu.** Phải đối chiếu `file.size` THẬT trên đĩa với checkpoint (`lastConfirmedByteOffset`) — nhỏ hơn thì checkpoint sai (lưu sớm hơn ghi thật), lớn hơn/bằng thì `truncate()` về đúng offset trước khi ghi tiếp (đuôi file có thể là byte dở dang của segment đang ghi lúc crash, không đảm bảo toàn vẹn).

## Chrome extension UI injection vào trang bất kỳ

- **CSS qua `<style>` tag hoặc `style=""` string bị `style-src` CSP CỦA TRANG chi phối** — Chrome âm thầm bỏ qua trên site không có `unsafe-inline`, không lỗi gì hiện ra. Style toàn bộ qua CSSOM trực tiếp (`el.style.xxx = ...`) — không bị `style-src` chi phối. Đánh đổi: mất `:hover` thật (cần CSS rule).
- **Navigate tới `chrome-extension://...` URL từ page-context (`<a href>`) bị Chrome chặn** ("This page has been blocked") trừ khi trang đó nằm trong `web_accessible_resources` — mở rộng `web_accessible_resources` cho một trang có đặc quyền cao (vd Dashboard) sẽ phơi nó cho bất kỳ site nào. Dùng `<button>` + `onAction` callback → `chrome.runtime.sendMessage` → relay trong background gọi `chrome.tabs.create()` (privileged, không bị chi phối).
- **`chrome.scripting.registerContentScripts`/`updateContentScripts` với `world:'MAIN'` cần `host_permissions` riêng** — một `content_scripts.matches` tĩnh KHÔNG thoả điều kiện này cho API động, dù cả hai hiện cùng một cảnh báo permission lúc cài đặt. Thiếu nó: promise resolve sạch, `getRegisteredContentScripts()` hiện đúng, nhưng script không bao giờ chạy trên trang nào — silent failure khó chẩn đoán nhất.
- **`@crxjs/vite-plugin`'s `?script&module` bị vỡ cho `chrome.scripting` injection** — để nguyên `import` ESM thật trong output; `chrome.scripting` luôn tiêm dưới dạng classic script → `SyntaxError` câm lặng trước khi bất kỳ dòng nào chạy. Dùng `?script&iife` (IIFE bundler riêng của crxjs, tự chứa hoàn toàn).
- **`chrome.userScripts` có thể là `undefined`** (không chỉ promise reject) khi "Allow User Scripts" chưa được cấp — `.then().catch()` không bắt được throw đồng bộ khi truy cập property; throw không bắt được ở top-level service worker làm hỏng TOÀN BỘ worker registration (Chrome status code 15), câm lặng xoá mọi listener khác trong file. Cần `try/catch` đồng bộ thật quanh cả lời gọi.
- **Nhiều console DevTools tách biệt, không chia sẻ output** (background service worker / mỗi extension page / mỗi content-script world ISOLATED vs MAIN) — log chứng minh chạy ở world này không nói lên gì về world khác. `chrome://inspect/#service-workers` đáng tin hơn link "service worker" ở `chrome://extensions` (có thể no-op câm lặng nếu worker đang ngủ).
- **Extra HTML entry (Dashboard/Review/Merge/Offscreen) không có field manifest chuẩn nào tự nhận diện** — phải khai tay Rollup input trong `vite.config.ts` (khác `side_panel`/`action.default_popup`, được `@crxjs/vite-plugin` tự nhận qua field manifest chuẩn).
- **`<dialog>.showModal()` bị clip trong Chrome MV3 popup** — top layer không tham gia auto-size của popup, nút Cancel/Close có thể render ngoài vùng nhìn thấy. Không dùng `<dialog>` trong popup; chuyển sang in-flow view-swap.

## Network sniffing / ad filtering

- **`chrome.webRequest.onHeadersReceived`, không phải `onBeforeRequest`, mới đọc được `Content-Type` thật** — cần cho filter theo Content-Type thay vì chỉ đoán qua đuôi URL.
- **MV3 KHÔNG có `webRequest.filterResponseData` (Firefox-only)** — `chrome.webRequest` vĩnh viễn chỉ headers-only, không có cách đọc body của request trang tự phát mà không đổi hẳn mechanism (debugger/CDP).
- **Domain/path/query-key denylist là whack-a-mole phản ứng-sau vĩnh viễn** — không chặn trước được mạng quảng cáo mới/domain xoay vòng. Khớp WHOLE path segment/query key, không substring (tránh `/uploads/` trúng `/ads/`). Nếu việc thêm domain thủ công lặp lại quá thường xuyên, cân nhắc blocklist lớn (EasyList/EasyPrivacy) qua DNR thay vì vá tiếp từng domain.
- **Ad-tech redirect URL thường mang query value còn NGUYÊN placeholder `{macroName}` chưa thay thế** (vd `cv1={impressionId}`) — tín hiệu junk mạnh, whole-value match.
- **Filter phải áp cả lên `pageUrl`/`initiator` của request, không chỉ URL request** — một media URL tự nó sạch hoàn toàn vẫn có thể tới từ một trang/iframe redirect ad-tech rõ ràng.
- **Correlation blob:→URL qua một biến TOÀN CỤC "lần quan sát gần nhất" sẽ gán lẫn lộn khi trang có nhiều player MSE cùng lúc** — cần buộc theo từng phần tử cụ thể (hook `MediaSource.addSourceBuffer`/sự kiện `'play'` capture-phase trên đúng phần tử) thay vì một biến dùng chung toàn trang.
- **Probe chủ động (magic-bytes/Range) đánh dấu "đã probe origin này" bất kể kết quả sẽ tự khoá vĩnh viễn cơ hội phát hiện sau này** nếu request mù đầu tiên tình cờ không phải media — chỉ nên đánh dấu khi probe thực sự vô ích, hoặc cap theo số lần thay vì cấm tuyệt đối.
- **Không tái dùng cơ chế header-replay (SET semantics) cho request probe cần header khác (vd `Range` nhỏ)** — nếu request gốc từng có `Range` bị capture, replay nó sẽ ghi đè đúng cái header probe cố tình set nhỏ.

## HLS / AES / DRM

- **`METHOD=AES-128` (khoá công khai qua `URI=` trong manifest) không phải DRM** — giải mã được bình thường. **`SAMPLE-AES` hoặc `KEYFORMAT` khác `identity`** (Widevine/PlayReady/FairPlay) mới là DRM thật — chặn cứng, không tìm cách vượt qua. Gộp chung hai loại này (như code cũ từng làm) chặn nhầm cả case hợp lệ.
- **IV mặc định khi manifest không khai `IV=` tường minh: media-sequence-number, big-endian, đệm 16 byte** (theo spec HLS).
- **`fetch()` không bao giờ reject vì HTTP status (401/403/500), chỉ reject khi lỗi mạng thật** — vòng lặp tải phải tự `if (!res.ok) throw`, nếu không một response lỗi (trang HTML/JSON) sẽ bị lưu nhầm làm nội dung media hợp lệ.
- **`isLive` (thiếu `#EXT-X-ENDLIST` và không phải `#EXT-X-PLAYLIST-TYPE:EVENT`) phải chặn cứng việc remap segment khi refresh manifest giữa chừng** — remap trên live playlist (thứ tự/nội dung segment không ổn định) không an toàn như remap trên VOD.

## Kiến trúc chung / quyết định nền

- **Service worker không có `DOMParser`** — không parse được XML (chặn hẳn việc làm DASH/`.mpd` cho tới khi có context khác, vd Offscreen Document, có `DOMParser`).
- **`fetch()` không bao giờ set được `Cookie`/`Authorization` từ JS dù ở extension page** (forbidden header names) — đừng thiết kế cơ chế replay header dựa trên việc lưu 2 header này, dù checklist/tài liệu ngoài có liệt kê.
- **Content-script fetch từ Chrome 85 tuân CORS theo origin của TRANG** — `host_permissions` không nới cho content script nữa; fetch cross-origin thật phải chạy ở background/Offscreen Document.
