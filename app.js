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
    questions:        null,

    /* ── Init ───────────────────────────────────── */
    init() {
        this._bindAll();
        this._loadVoices();
        this._loadQuestions();
    },

    _loadQuestions() {
        fetch(`${API}/api/questions`)
            .then(r => r.json())
            .then(data => { this.questions = data; })
            .catch(() => {});
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
                this.applicant  = { id: data.id, name, birthdate, phone };
                this.currentAttempt = null;
                this.transcripts = {};
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

    /* ── 인터뷰 시작 → Q1 ──────────────────────── */
    async onStart() {
        if (!document.getElementById('chk-consent').checked) {
            alert('개인정보 수집 · 이용에 동의해주세요.');
            return;
        }
        if (!this.applicant) {
            alert('이름, 생년월일, 전화번호를 입력해주세요.');
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

        try {
            const stream = await this.getStream();
            document.getElementById('vid-q1').srcObject = stream;
            this.show('q1');
            this.startRec(stream);

            const timerEl = document.getElementById('q1-timer');
            this.countdown(
                600,
                rem => {
                    timerEl.textContent = this.fmt(rem);
                    timerEl.className   = rem <= 30 ? 'timer danger'
                                        : rem <= 60 ? 'timer warn' : 'timer';
                },
                () => this.onQ1Done()
            );

            // TTS 종료 후 음성 인식 시작 (TTS 음성이 인식되지 않도록)
            const q1 = this.questions && this.questions.Q1;
            if (q1) document.getElementById('overlay-q1').textContent = q1.display;
            this.speak(q1 ? q1.tts : '')
                .then(() => this.startTranscription('sr-q1'));
        } catch (err) { this._camErr(err); }
    },

    /* ── Q1 완료 ────────────────────────────────── */
    async onQ1Done() {
        this._stopTicker();
        document.getElementById('btn-q1-done').disabled = true;

        const text = this.stopTranscription('sr-q1');
        this.transcripts[1] = text;

        const blob = await this.stopRec();
        this._releaseStream();

        this.show('q1-done');

        const st = document.getElementById('up-status-1');
        st.textContent = '업로드 중...';
        st.className   = 'up-status';

        const nextBtn = document.getElementById('btn-next-q2');
        nextBtn.disabled = true;

        this.upload(blob, 1, text, p => {
            st.textContent = `업로드 중... ${Math.round(p * 100)}%`;
        }).then(r => {
            st.textContent = (r && r.success) ? '✓ 업로드 완료' : '업로드 실패';
            st.className   = (r && r.success) ? 'up-status ok'  : 'up-status err';
        }).catch(() => {
            st.textContent = '업로드 실패 (네트워크를 확인해주세요)';
            st.className   = 'up-status err';
        }).finally(() => {
            nextBtn.disabled = false;
        });

        document.getElementById('btn-q1-done').disabled = false;
    },

    /* ── Q2 시작 ────────────────────────────────── */
    async onQ2Start() {
        document.getElementById('btn-next-q2').disabled = true;   // 더블클릭 방지
        try {
            const stream = await this.getStream();
            document.getElementById('vid-q2').srcObject = stream;
            this.show('q2');
            this.startRec(stream);

            const timerEl = document.getElementById('q2-timer');
            this.countdown(
                600,
                rem => {
                    timerEl.textContent = this.fmt(rem);
                    timerEl.className   = rem <= 30 ? 'timer danger'
                                        : rem <= 60 ? 'timer warn' : 'timer';
                },
                () => this.onQ2Done()
            );

            const q2 = this.questions && this.questions.Q2;
            if (q2) document.getElementById('overlay-q2').textContent = q2.display;
            this.speak(q2 ? q2.tts : '')
                .then(() => this.startTranscription('sr-q2'));
        } catch (err) {
            document.getElementById('btn-next-q2').disabled = false;
            this._camErr(err);
        }
    },

    /* ── Q2 완료 ────────────────────────────────── */
    async onQ2Done() {
        this._stopTicker();
        document.getElementById('btn-q2-done').disabled = true;

        const text = this.stopTranscription('sr-q2');
        this.transcripts[2] = text;

        // 즉시 완료 화면으로 전환 (타이머 자동 종료 시 버튼 비활성 상태로 대기하는 문제 해결)
        this.show('complete');

        const st = document.getElementById('up-status-2');
        st.textContent = '영상을 업로드 중입니다...';
        st.className   = 'up-status';

        const exitBtn = document.getElementById('btn-exit');
        exitBtn.disabled = true;

        const blob = await this.stopRec();
        this._releaseStream();

        this.upload(blob, 2, text, p => {
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

        $('btn-q1-done').addEventListener('click',  () => this.onQ1Done());
        $('btn-next-q2').addEventListener('click',  () => this.onQ2Start());
        $('btn-q2-done').addEventListener('click',  () => this.onQ2Done());

        $('btn-exit').addEventListener('click', () => {
            this.applicant   = null;
            this.currentAttempt = null;
            this.transcripts = {};
            $('save-msg').textContent = '';
            $('save-msg').className   = 'save-msg';
            $('chk-consent').checked  = false;
            $('btn-start').disabled   = true;
            this.show('main');
        });
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
