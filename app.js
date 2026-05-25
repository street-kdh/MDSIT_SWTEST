'use strict';

/* ═══════════════════════════════════════════════════
   MDS인텔리전스 사전인터뷰 · 클라이언트 앱
═══════════════════════════════════════════════════ */

// config.js 에서 주입된 API 서버 주소 (없으면 같은 오리진 사용)
const API = (window.INTERVIEW_CONFIG && window.INTERVIEW_CONFIG.apiBase) || '';

const App = {
    /* ── State ──────────────────────────────────── */
    applicant:        null,   // { id, name, birthdate, phone }
    currentAttempt:   null,   // 현재 인터뷰 회차
    stream:           null,   // MediaStream
    recorder:         null,   // MediaRecorder
    chunks:           [],     // 녹화 청크
    ticker:           null,   // 카운트다운 interval
    testBlobUrl:      null,   // 테스트 blob URL

    // 음성 인식
    recognition:      null,   // SpeechRecognition 인스턴스
    currentText:      '',     // 인식 중 누적 텍스트
    transcripts:      {},     // { 1: '...', 2: '...' } 최종 전사

    // 질문 (서버에서 동적 로드)
    config:           null,   // { teamName, questionCount, mainNotices }
    qList:            null,   // 질문 배열 (resolved)

    /* ── Init ───────────────────────────────────── */
    init() {
        this._bindAll();
        this._loadVoices();
        this._loadConfig();
    },

    /* ── 공개 설정 로드 (페이지 초기화 시) ──────────── */
    _loadConfig() {
        fetch(`${API}/api/config`)
            .then(r => r.json())
            .then(data => {
                this.config = data;
                if (data.mainNotices && data.mainNotices.length) {
                    this._applyMainNotices(data.mainNotices);
                }
            })
            .catch(() => {});
    },

    _applyMainNotices(notices) {
        const box = document.getElementById('info-box');
        if (!box) return;
        box.innerHTML = notices.map(n => `<p>${n}</p>`).join('');
    },

    /* ── 질문 로드 (저장 성공 후) ──────────────────── */
    _loadQuestions(applicantId) {
        fetch(`${API}/api/questions?applicantId=${encodeURIComponent(applicantId)}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data) && data.length) {
                    this.qList = data;
                    this._buildScreens();
                }
            })
            .catch(() => {});
    },

    /* ── 질문 화면 동적 생성 ─────────────────────── */
    _buildScreens() {
        // 이전에 생성된 화면 제거
        document.querySelectorAll('.screen.dyn-q').forEach(el => el.remove());

        const complete = document.getElementById('screen-complete');
        const total    = this.qList.length;
        const frag     = document.createDocumentFragment();

        for (let i = 1; i <= total; i++) {
            const q = this.qList[i - 1];

            // 질문 화면
            const qWrap = document.createElement('div');
            qWrap.innerHTML = q.type === 'code'
                ? this._codeScreenHtml(i, total, q)
                : this._textScreenHtml(i, total);
            const qScreen = qWrap.firstElementChild;
            qScreen.classList.add('dyn-q');
            frag.appendChild(qScreen);

            // 완료 대기 화면 (마지막 질문 제외)
            if (i < total) {
                const wWrap = document.createElement('div');
                wWrap.innerHTML = this._waitScreenHtml(i);
                const wScreen = wWrap.firstElementChild;
                wScreen.classList.add('dyn-q');
                frag.appendChild(wScreen);
            }
        }

        complete.parentNode.insertBefore(frag, complete);

        // 이벤트 바인딩
        for (let i = 1; i <= total; i++) {
            const doneBtn = document.getElementById(`btn-q${i}-done`);
            if (doneBtn) {
                const n = i;
                doneBtn.addEventListener('click', () => this.onQDone(n));
            }
            if (i < total) {
                const nextBtn = document.getElementById(`btn-next-q${i + 1}`);
                if (nextBtn) {
                    const n = i;
                    nextBtn.addEventListener('click', () => this.onQStart(n + 1));
                }
            }
        }
    },

    _escHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    _textScreenHtml(n, total) {
        return `<div id="screen-q${n}" class="screen">
  <div class="cam-wrap">
    <video id="vid-q${n}" autoplay muted playsinline webkit-playsinline></video>
    <div class="cam-overlay">
      <div class="q-badge">${n} / ${total}</div>
      <div id="q${n}-timer" class="timer">10:00</div>
      <p class="overlay-q" id="overlay-q${n}"></p>
      <div class="badge-row">
        <div class="rec-badge"><span class="rec-dot"></span>REC</div>
        <div id="sr-q${n}" class="sr-badge" style="display:none"><span class="sr-dot"></span>음성 인식 중</div>
      </div>
      <button id="btn-q${n}-done" class="btn btn-done">완료</button>
    </div>
  </div>
</div>`;
    },

    _codeScreenHtml(n, total, q) {
        return `<div id="screen-q${n}" class="screen screen-code-q">
  <div class="code-screen">
    <div class="code-header">
      <span class="code-badge">${n} / ${total}</span>
      <div id="q${n}-timer" class="timer">10:00</div>
    </div>
    <p class="code-title" id="q${n}-title">${this._escHtml(q.title)}</p>
    <div class="code-block">
      <pre id="q${n}-code">${this._escHtml(q.code)}</pre>
    </div>
    <div class="code-footer">
      <div class="badge-row">
        <div class="rec-badge"><span class="rec-dot"></span>REC</div>
        <div id="sr-q${n}" class="sr-badge" style="display:none"><span class="sr-dot"></span>음성 인식 중</div>
      </div>
      <button id="btn-q${n}-done" class="btn btn-done">완료</button>
    </div>
  </div>
  <video id="vid-q${n}" autoplay muted playsinline webkit-playsinline class="q3-pip"></video>
</div>`;
    },

    _waitScreenHtml(n) {
        const ords = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
        const ord  = ords[n - 1] || String(n);
        return `<div id="screen-q${n}-done" class="screen dark-center">
  <div class="msg-card">
    <div class="icon-big">✓</div>
    <h2>${ord} 번째 답변 완료</h2>
    <p>준비가 되셨으면 다음 항목을 위하여<br>다음 버튼을 눌러주세요.</p>
    <div id="up-status-${n}" class="up-status">업로드 중...</div>
    <button id="btn-next-q${n + 1}" class="btn btn-primary">다음 →</button>
  </div>
</div>`;
    },

    /* ── Screen switcher ────────────────────────── */
    show(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('screen-' + name).classList.add('active');
    },

    /* ── TTS ────────────────────────────────────── */
    _voices: [],
    _loadVoices() {
        if (!('speechSynthesis' in window)) return;
        const load = () => { this._voices = speechSynthesis.getVoices(); };
        load();
        speechSynthesis.addEventListener('voiceschanged', load);
    },

    speak(text) {
        return new Promise(resolve => {
            if (!('speechSynthesis' in window)) return resolve();
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang   = 'ko-KR';
            u.rate   = 0.88;
            u.pitch  = 1;
            u.volume = 1;
            const ko = this._voices.find(v => v.lang.startsWith('ko'));
            if (ko) u.voice = ko;
            u.onend  = resolve;
            u.onerror = resolve;
            speechSynthesis.speak(u);
        });
    },

    /* ── Camera / Mic ───────────────────────────── */
    async getStream() {
        this._releaseStream();
        const s = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        this.stream = s;
        return s;
    },

    _releaseStream() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
    },

    /* ── MediaRecorder ──────────────────────────── */
    _mimeType() {
        // Windows 10 호환: MP4(H.264)를 최우선으로 시도
        const list = [
            'video/mp4;codecs=h264,aac',
            'video/mp4;codecs=h264',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ];
        if (typeof MediaRecorder === 'undefined') return '';
        return list.find(t => MediaRecorder.isTypeSupported(t)) || '';
    },

    startRec(stream) {
        this.chunks = [];
        const mime = this._mimeType();
        this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
        this.recorder.ondataavailable = e => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        this.recorder.start(1000);
    },

    stopRec() {
        return new Promise(resolve => {
            const mime = this._mimeType() || 'video/mp4';
            if (!this.recorder || this.recorder.state === 'inactive') {
                return resolve(new Blob(this.chunks, { type: mime }));
            }
            const finish = () => resolve(new Blob(this.chunks, { type: mime }));
            const guard = setTimeout(finish, 5000);   // onstop 미발생 대비
            this.recorder.onstop = () => { clearTimeout(guard); finish(); };
            this.recorder.stop();
        });
    },

    /* ── 음성 인식 (SpeechRecognition) ─────────── */
    startTranscription(srBadgeId) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;

        this.currentText = '';
        const rec = new SR();
        rec.lang             = 'ko-KR';
        rec.continuous       = true;
        rec.interimResults   = false;
        rec.maxAlternatives  = 1;

        rec.onresult = e => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    this.currentText += e.results[i][0].transcript;
                }
            }
        };

        rec.onerror = e => {
            if (e.error !== 'no-speech' && e.error !== 'aborted') {
                console.warn('음성 인식 오류:', e.error);
            }
        };

        // 음성 인식은 침묵 감지 시 자동 종료 → 다시 시작
        rec.onend = () => {
            if (this.recognition === rec &&
                this.recorder && this.recorder.state === 'recording') {
                setTimeout(() => {
                    try { rec.start(); } catch {}
                }, 150);
            }
        };

        this.recognition = rec;
        try {
            rec.start();
            if (srBadgeId) document.getElementById(srBadgeId).style.display = 'flex';
        } catch (err) {
            console.warn('음성 인식 시작 불가:', err);
            this.recognition = null;
        }
    },

    stopTranscription(srBadgeId) {
        const rec = this.recognition;
        this.recognition = null;        // onend 재시작 방지
        if (rec) { try { rec.abort(); } catch {} }
        if (srBadgeId) document.getElementById(srBadgeId).style.display = 'none';
        const text = this.currentText.trim();
        this.currentText = '';
        return text;
    },

    /* ── Countdown ──────────────────────────────── */
    _stopTicker() {
        if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    },

    countdown(seconds, onTick, onDone) {
        let rem = seconds;
        onTick(rem);
        this.ticker = setInterval(() => {
            rem--;
            onTick(rem);
            if (rem <= 0) { this._stopTicker(); onDone(); }
        }, 1000);
    },

    fmt(s) {
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    },

    /* ── Upload ─────────────────────────────────── */
    upload(blob, qNum, transcript, onProgress) {
        const { name, birthdate, phone, id } = this.applicant;
        const raw  = `${name}_${birthdate}_${phone}`;
        const safe = raw.replace(/[^\w가-힣]/g, '_');
        const ext  = blob.type.includes('mp4') ? 'mp4' : 'webm';
        const file = `${safe}_Q${qNum}.${ext}`;

        const fd = new FormData();
        fd.append('video',      blob, file);
        fd.append('transcript', transcript || '');

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.timeout = 600000;   // 10분 타임아웃

            const qs = new URLSearchParams({
                prefix:      safe,
                question:    qNum,
                applicantId: id,
                name:        name,
                birthdate:   birthdate,
                phone:       phone
            });
            if (this.currentAttempt) {
                qs.set('attempt', this.currentAttempt);
            }
            const qDef = this.qList && this.qList[qNum - 1];
            if (qDef && qDef.type === 'code' && qDef.questionId) {
                qs.set('questionId', qDef.questionId);
            }
            xhr.open('POST', `${API}/api/upload?` + qs);

            if (onProgress) {
                xhr.upload.onprogress = e => {
                    if (e.lengthComputable) onProgress(e.loaded / e.total);
                };
            }
            xhr.onload    = () => {
                try { resolve(JSON.parse(xhr.responseText)); }
                catch { reject(new Error('응답 파싱 실패')); }
            };
            xhr.onerror   = () => reject(new Error('네트워크 오류'));
            xhr.ontimeout = () => reject(new Error('업로드 시간 초과'));
            xhr.send(fd);
        });
    },

    /* ── Camera error ───────────────────────────── */
    _camErr(err) {
        const n = err.name || '';
        if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
            alert('카메라와 마이크 접근 권한이 필요합니다.\n브라우저 설정에서 이 사이트의 카메라/마이크 권한을 허용해주세요.');
        } else if (n === 'NotFoundError') {
            alert('카메라 또는 마이크를 찾을 수 없습니다.\n장치가 연결되어 있는지 확인해주세요.');
        } else {
            alert('카메라/마이크를 시작할 수 없습니다.\n오류: ' + err.message);
        }
    },

    /* ══════════════════════════════════════════════
       HANDLERS
    ══════════════════════════════════════════════ */

    /* ── 저장 ──────────────────────────────────── */
    async onSave() {
        const name      = document.getElementById('inp-name').value.trim();
        const birthdate = document.getElementById('inp-birth').value.trim();
        const phone     = document.getElementById('inp-phone').value.trim();

        if (!name || !birthdate || !phone) {
            alert('이름, 생년월일, 전화번호를 모두 입력해주세요.');
            return;
        }

        const msg = document.getElementById('save-msg');
        msg.textContent = '저장 중...';
        msg.className   = 'save-msg ing';

        try {
            const res  = await fetch(`${API}/api/applicant`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ name, birthdate, phone })
            });
            const data = await res.json();

            if (data.success) {
                this.applicant       = { id: data.id, name, birthdate, phone };
                this.currentAttempt  = null;
                this.transcripts     = {};
                this._loadQuestions(data.id);
                msg.textContent = '✓ 저장되었습니다.';
                msg.className   = 'save-msg ok';
            } else {
                throw new Error(data.error || '저장 실패');
            }
        } catch (err) {
            msg.textContent = '저장 실패: ' + err.message;
            msg.className   = 'save-msg err';
        }
    },

    /* ── 테스트 시작 ────────────────────────────── */
    async onTest() {
        try {
            const stream = await this.getStream();
            document.getElementById('vid-test-live').srcObject = stream;
            this.show('test');
            this.startRec(stream);

            const el = document.getElementById('test-count');
            this.speak('10초간 테스트 중 입니다. 카메라와 마이크를 테스트 해보세요');
            this.countdown(
                10,
                rem => { el.textContent = rem; },
                ()  => this._finishTest()
            );
        } catch (err) { this._camErr(err); }
    },

    async _finishTest() {
        const blob = await this.stopRec();
        this._releaseStream();

        if (this.testBlobUrl) URL.revokeObjectURL(this.testBlobUrl);
        this.testBlobUrl = URL.createObjectURL(blob);

        const pbVid = document.getElementById('vid-test-pb');
        pbVid.src = this.testBlobUrl;

        document.getElementById('play-overlay').style.display = 'flex';
        document.getElementById('play-after').style.display   = 'none';

        this.show('test-play');
    },

    onPlayTest() {
        document.getElementById('play-overlay').style.display = 'none';
        document.getElementById('vid-test-pb').play();
    },

    onReplay() {
        const vid = document.getElementById('vid-test-pb');
        document.getElementById('play-after').style.display = 'none';
        vid.currentTime = 0;
        vid.play();
    },

    _clearTestBlob() {
        if (this.testBlobUrl) { URL.revokeObjectURL(this.testBlobUrl); this.testBlobUrl = null; }
        document.getElementById('vid-test-pb').src = '';
    },

    onBackMain() {   // 테스트 재생 화면 → 인터뷰 바로 시작
        this._clearTestBlob();
        this.onStart();
    },

    onRetest() {     // 테스트 재생 화면 → 테스트 다시하기
        this._clearTestBlob();
        this.onTest();
    },

    /* ── 인터뷰 시작 ────────────────────────────── */
    async onStart() {
        if (!document.getElementById('chk-consent').checked) {
            alert('개인정보 수집 · 이용에 동의해주세요.');
            return;
        }
        if (!this.applicant) {
            alert('이름, 생년월일, 전화번호를 입력해주세요.');
            return;
        }
        if (!this.qList || this.qList.length === 0) {
            alert('질문 데이터를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
            return;
        }

        // 시작 횟수 서버 기록
        const { name, birthdate, phone, id } = this.applicant;
        this.currentAttempt = null;
        try {
            const startRes = await fetch(`${API}/api/start`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ applicantId: id, name, birthdate, phone })
            });
            if (startRes.ok) {
                const startData = await startRes.json();
                if (startData && startData.attempt) {
                    this.currentAttempt = startData.attempt;
                }
            }
        } catch {}

        await this.onQStart(1);
    },

    /* ── 질문 n 시작 ────────────────────────────── */
    async onQStart(n) {
        const q        = this.qList[n - 1];
        const prevNext = n > 1 ? document.getElementById(`btn-next-q${n}`) : null;
        if (prevNext) prevNext.disabled = true;

        try {
            const stream = await this.getStream();
            document.getElementById(`vid-q${n}`).srcObject = stream;
            this.show(`q${n}`);
            this.startRec(stream);

            if (q.type === 'text') {
                const ov = document.getElementById(`overlay-q${n}`);
                if (ov) ov.textContent = q.display || '';
            }

            const timerEl = document.getElementById(`q${n}-timer`);
            const dur     = q.durationSec || 600;
            this.countdown(
                dur,
                rem => {
                    timerEl.textContent = this.fmt(rem);
                    timerEl.className   = rem <= 30 ? 'timer danger'
                                        : rem <= 60 ? 'timer warn' : 'timer';
                },
                () => this.onQDone(n)
            );

            // TTS 종료 후 음성 인식 시작 (TTS 음성이 인식되지 않도록)
            this.speak(q.tts || '')
                .then(() => this.startTranscription(`sr-q${n}`));
        } catch (err) {
            if (prevNext) prevNext.disabled = false;
            this._camErr(err);
        }
    },

    /* ── 질문 n 완료 ────────────────────────────── */
    async onQDone(n) {
        this._stopTicker();
        const doneBtn = document.getElementById(`btn-q${n}-done`);
        if (doneBtn) doneBtn.disabled = true;

        const text  = this.stopTranscription(`sr-q${n}`);
        this.transcripts[n] = text;

        const total  = this.qList.length;
        const isLast = (n === total);

        if (isLast) {
            // 완료 화면 먼저 표시 후 업로드
            this.show('complete');
            const st      = document.getElementById('up-status-final');
            const exitBtn = document.getElementById('btn-exit');
            st.textContent   = '영상을 업로드 중입니다...';
            st.className     = 'up-status';
            exitBtn.disabled = true;

            const blob = await this.stopRec();
            this._releaseStream();

            const q        = this.qList[n - 1];
            const qPrefix  = (q.type === 'code' && q.questionId)
                ? `[문제: ${q.questionId}] ${q.title}\n\n`
                : '';

            this.upload(blob, n, qPrefix + text, p => {
                st.textContent = `업로드 중... ${Math.round(p * 100)}%`;
            }).then(r => {
                st.textContent = (r && r.success)
                    ? '✓ 모든 영상이 성공적으로 업로드되었습니다.'
                    : '업로드 실패. 관리자에게 문의해주세요.';
                st.className = (r && r.success) ? 'up-status ok' : 'up-status err';
            }).catch(() => {
                st.textContent = '업로드 실패. 관리자에게 문의해주세요.';
                st.className   = 'up-status err';
            }).finally(() => {
                exitBtn.disabled = false;
            });
        } else {
            // 대기 화면으로 이동 후 백그라운드 업로드
            const blob = await this.stopRec();
            this._releaseStream();

            this.show(`q${n}-done`);

            const st      = document.getElementById(`up-status-${n}`);
            const nextBtn = document.getElementById(`btn-next-q${n + 1}`);
            st.textContent       = '업로드 중...';
            st.className         = 'up-status';
            if (nextBtn) nextBtn.disabled = true;

            this.upload(blob, n, text, p => {
                st.textContent = `업로드 중... ${Math.round(p * 100)}%`;
            }).then(r => {
                st.textContent = (r && r.success) ? '✓ 업로드 완료' : '업로드 실패';
                st.className   = (r && r.success) ? 'up-status ok'  : 'up-status err';
            }).catch(() => {
                st.textContent = '업로드 실패 (네트워크를 확인해주세요)';
                st.className   = 'up-status err';
            }).finally(() => {
                if (nextBtn) nextBtn.disabled = false;
            });

            if (doneBtn) doneBtn.disabled = false;
        }
    },

    /* ── Event binding ──────────────────────────── */
    _bindAll() {
        const $ = id => document.getElementById(id);

        $('btn-save').addEventListener('click',      () => this.onSave());
        $('btn-test').addEventListener('click',      () => this.onTest());
        $('btn-start').addEventListener('click',     () => this.onStart());

        $('chk-consent').addEventListener('change', e => {
            $('btn-start').disabled = !e.target.checked;
        });

        $('btn-play-test').addEventListener('click', () => this.onPlayTest());
        $('btn-replay').addEventListener('click',    () => this.onReplay());
        $('btn-retest').addEventListener('click',    () => this.onRetest());
        $('btn-back-main').addEventListener('click', () => this.onBackMain());

        $('vid-test-pb').addEventListener('ended', () => {
            $('play-after').style.display = 'flex';
        });

        $('btn-exit').addEventListener('click', () => {
            this.applicant      = null;
            this.currentAttempt = null;
            this.transcripts    = {};
            this.qList          = null;
            $('save-msg').textContent = '';
            $('save-msg').className   = 'save-msg';
            $('chk-consent').checked  = false;
            $('btn-start').disabled   = true;
            this.show('main');
        });
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
