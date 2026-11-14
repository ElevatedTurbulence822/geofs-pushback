// ==UserScript==
// @name         Geo-FS Pushback Remake (Immediate Steering)
// @version      3.2
// @description  Immediate direct steering for tug and aircraft pushback
// @author       TYC-CCA125
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    /* ======================================================================
       语音播报
       ====================================================================== */
    const VO = {
        synth: window.speechSynthesis,
        _queue: [],
        _busy: false,
        _cfg: { rate: 0.88, pitch: 0.85, volume: 1.0, lang: 'en-US' },
        speak(text, delayMs = 0) {
            setTimeout(() => {
                this._queue.push(text);
                if (!this._busy) this._flush();
            }, delayMs);
        },
        _flush() {
            if (!this._queue.length) {
                this._busy = false;
                return;
            }
            this._busy = true;
            const utt = new SpeechSynthesisUtterance(this._queue.shift());
            Object.assign(utt, this._cfg);
            const voices = this.synth.getVoices();
            const pick = voices.find(v => /male|david|mark|james|guy/i.test(v.name))
                      || voices.find(v => v.lang.startsWith('en'));
            if (pick) utt.voice = pick;
            utt.onend = () => this._flush();
            utt.onerror = () => this._flush();
            this.synth.speak(utt);
        },
        cancel() {
            this._queue = [];
            this._busy = false;
            this.synth.cancel();
        }
    };

    window.addEventListener('click', () => {
        if (VO.synth.getVoices().length === 0) VO.synth.getVoices();
    }, { once: true });

    /* ======================================================================
       常量 / 状态
       ====================================================================== */
    const MAX_SPEED_MPS = 5.0;
    const TURN_RATE_RAD = 0.139626; // 满舵约 12°/秒（原来 16°/秒）
    const TURN_DEADZONE = 0.0005;
    const INPUT_RESPONSE = 48;

    // 0.75：低舵量只是温和放大，整体更柔和；1 = 线性。
    // 滑块 1 格(0.02) 约 0.65°/s，满舵约 12°/s。
    const STEER_CURVE = 0.75;

    const YAW_AXIS = 'z';
    const STEER_ANIM_SCALE = 1.35;

    const DATA_INFO_URLS = [
        'https://cdn.jsdelivr.net/gh/TotallyRealElonMusk/GeoFS-Pushback@main/pushback%20data/pushback.json',
        'https://gcore.jsdelivr.net/gh/TotallyRealElonMusk/GeoFS-Pushback@main/pushback%20data/pushback.json',
        'https://raw.githubusercontent.com/TotallyRealElonMusk/GeoFS-Pushback/main/pushback%20data/pushback.json'
    ];

    const DATA_MODEL_URLS = [
        'https://cdn.jsdelivr.net/gh/TotallyRealElonMusk/GeoFS-Pushback@main/pushback%20data/pushbackModel.json',
        'https://gcore.jsdelivr.net/gh/TotallyRealElonMusk/GeoFS-Pushback@main/pushback%20data/pushbackModel.json',
        'https://raw.githubusercontent.com/TotallyRealElonMusk/GeoFS-Pushback/main/pushback%20data/pushbackModel.json'
    ];

    const CACHE_KEY = 'geofs-pushback-data-v1';

    let pushbackInfo, pushbackModels, defaultFriction;
    let rafId = null;

    /* ======================================================================
       工具函数
       ====================================================================== */
    function num(v, def) {
        return (typeof v === 'number' && isFinite(v)) ? v : def;
    }

    // 读取当前航向角（度，0=正北，顺时针）
    function readHeadingDeg() {
        let h;

        try {
            h = geofs.animation.values.heading360;
        } catch (e) {
            h = undefined;
        }

        if (typeof h !== 'number' || !isFinite(h)) {
            try {
                // GeoFS 的 object3d 没有 .rotation，使用 htr[0]（度）。
                h = geofs.aircraft.instance.object3d.htr[0];
            } catch (e2) {
                h = 0;
            }
        }

        h = num(h, 0);
        return ((h % 360) + 360) % 360;
    }

    function getRigidBody() {
        try {
            return geofs.aircraft.instance.rigidBody;
        } catch (e) {
            return null;
        }
    }

    function getObject3d() {
        try {
            return geofs.aircraft.instance.object3d;
        } catch (e) {
            return null;
        }
    }

    // 如果游戏内左右方向相反，把 -1 改成 1。
    let YAW_SIGN = -1;

    const RAD_TO_DEG = 180 / Math.PI;
    const DEG_TO_RAD = Math.PI / 180;

    function wrap360(deg) {
        return ((deg % 360) + 360) % 360;
    }

    // 取 -180..180 的最短夹角，跨 0/360 度时不会突然反向。
    function shortestAngle(deg) {
        return ((deg + 540) % 360) - 180;
    }

    // 直接从姿态矩阵读航向，和 GeoFS 的 M33.toEuler 完全一致。
    // 不读 heading360，避免物理更新与脚本更新不同步时航向来回跳。
    function matrixHeadingDeg(obj) {
        try {
            const m = obj && obj._initialRotation;

            if (m && m[0] && m[1]) {
                return Math.atan2(m[1][0], m[1][1]) * RAD_TO_DEG;
            }
        } catch (e) {}

        return readHeadingDeg();
    }

    // 绕世界垂直轴转向（真正的航向轴）。
    // 原来的 rotateInitialRotation([0,0,delta]) 是绕机体 Z 轴转：
    // 飞机只要有一点俯仰/滚转，每一帧就会同时改变横滚，
    // 悬挂再把它拉回来，于是就出现左右抖动。
    function rotateWorldYaw(obj, deltaRad) {
        const m = obj && obj._initialRotation;

        if (!m || !m[0] || !m[1] || !m[2]) return false;

        if (!isFinite(deltaRad) || deltaRad === 0) return true;

        const c = Math.cos(deltaRad);
        const s = Math.sin(deltaRad);

        const r0 = [
            m[0][0] * c - m[1][0] * s,
            m[0][1] * c - m[1][1] * s,
            m[0][2] * c - m[1][2] * s
        ];

        const r1 = [
            m[0][0] * s + m[1][0] * c,
            m[0][1] * s + m[1][1] * c,
            m[0][2] * s + m[1][2] * c
        ];

        const r2 = [m[2][0], m[2][1], m[2][2]];

        obj._initialRotation = [r0, r1, r2];
        obj._rotation = [
            [r0[0], r0[1], r0[2]],
            [r1[0], r1[1], r1[2]],
            [r2[0], r2[1], r2[2]]
        ];

        return true;
    }

    // 只清掉机体偏航角速度，保留俯仰/滚转，避免和悬挂较劲。
    function zeroPhysicsYaw(rb, obj) {
        if (!rb || typeof rb.setAngularVelocity !== 'function') return;

        try {
            const av = (typeof rb.getAngularVelocity === 'function'
                ? rb.getAngularVelocity()
                : null) || [0, 0, 0];

            const ax = num(av[0], 0);
            const ay = num(av[1], 0);
            const az = num(av[2], 0);

            const m = obj && obj._initialRotation;

            if (!m || !m[0] || !m[1] || !m[2]) {
                rb.setAngularVelocity([ax, ay, 0]);
                return;
            }

            // 世界角速度 -> 机体角速度（转置矩阵）。
            const lx =
                m[0][0] * ax +
                m[1][0] * ay +
                m[2][0] * az;

            const ly =
                m[0][1] * ax +
                m[1][1] * ay +
                m[2][1] * az;

            const lz =
                m[0][2] * ax +
                m[1][2] * ay +
                m[2][2] * az;

            // 机体角速度 -> 世界角速度，但把偏航分量 lz 清零。
            rb.setAngularVelocity([
                m[0][0] * lx + m[0][1] * ly,
                m[1][0] * lx + m[1][1] * ly,
                m[2][0] * lx + m[2][1] * ly
            ]);
        } catch (e) {}
    }

    // 直接改机身姿态角，不经过刚体角速度 / 轮胎摩擦。
    // GeoFS 的 integrateTransform 只有在角速度 > 0.01 rad/s 时才会转向，
    // 小舵量会被这个阈值和地面摩擦吃掉；直接改姿态可以完全绕过它。
    function applyYawRate(rateRadPerSec, dt = 0.016) {
        const rb = getRigidBody();
        const obj = getObject3d();
        const delta = rateRadPerSec * dt;

        if (obj && obj._initialRotation) {
            try {
                if (isFinite(delta) && delta !== 0) {
                    if (pushback._targetHeading == null) {
                        pushback._targetHeading =
                            matrixHeadingDeg(obj);
                    }

                    if (rotateWorldYaw(obj, delta)) {
                        pushback._targetHeading = wrap360(
                            pushback._targetHeading +
                            delta * RAD_TO_DEG
                        );
                    }
                }

                zeroPhysicsYaw(rb, obj);
                return;
            } catch (e) {}
        }

        // 回退：没有姿态接口时使用刚体角速度。
        if (rb) {
            try {
                if (typeof rb.setAngularVelocity === 'function') {
                    rb.setAngularVelocity([0, 0, rateRadPerSec]);
                    return;
                }
            } catch (e) {}

            try {
                if (rb.angularVelocity &&
                    typeof rb.angularVelocity.set === 'function') {
                    const av = rb.angularVelocity;
                    const x = num(av.x, 0);
                    const y = num(av.y, 0);
                    av.set(x, y, rateRadPerSec);
                    return;
                }
            } catch (e) {}
        }

        // 最后回退：直接改渲染旋转（可能被下一帧覆盖）。
        if (obj && obj.rotation) {
            try {
                obj.rotation.z += delta;
            } catch (e) {}
        }
    }

    // speed > 0 沿机头方向前进，< 0 后退。
    function applyVelocity(speedMps, headingDeg) {
        const rb = getRigidBody();
        if (!rb) return;

        const h = (typeof headingDeg === 'number')
            ? headingDeg
            : readHeadingDeg();

        const rad = h * Math.PI / 180;
        const vx = Math.sin(rad) * speedMps;
        const vy = Math.cos(rad) * speedMps;

        try {
            rb.setLinearVelocity([vx, vy, 0]);
        } catch (e) {}
    }

    // GeoFS 的物理更新和渲染都在它自己的循环里完成。
    // 如果只在 rAF 里改姿态，屏幕上画的始终是“物理修正前”的机身，
    // 轮胎摩擦每帧把机头推回来一点，看起来就是左右抖。
    // 这里在真正渲染前把航向锁回目标值，抖动就不会被画出来。
    function enforceSteeringTarget(ac) {
        const obj = ac && ac.object3d;
        if (!obj || !obj._initialRotation) return;

        const target = pushback._targetHeading;

        if (target != null) {
            const actual = matrixHeadingDeg(obj);
            const err = shortestAngle(target - actual);

            if (Math.abs(err) > 0.001) {
                rotateWorldYaw(obj, err * DEG_TO_RAD);
            }
        }

        zeroPhysicsYaw(ac.rigidBody, obj);

        try {
            obj.compute(ac.llaLocation);
            ac.htr = obj.htr;
        } catch (e) {}

        applyVelocity(num(pushback.speed, 0), matrixHeadingDeg(obj));
    }

    function installRenderHook() {
        try {
            const proto = geofs.aircraft &&
                geofs.aircraft.Aircraft &&
                geofs.aircraft.Aircraft.prototype;

            if (!proto || proto._pushbackRenderHooked) return;

            const origRender = proto.render;

            proto.render = function () {
                try {
                    if (window.pushback && pushback.pushBackState) {
                        enforceSteeringTarget(this);
                    }
                } catch (e) {}

                return origRender.apply(this, arguments);
            };

            proto._pushbackRenderHooked = true;
        } catch (e) {}
    }

    /* ======================================================================
       核心：即时直接转向
       ====================================================================== */
    const RAF = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : function (cb) {
            return setTimeout(function () {
                cb(Date.now());
            }, 16);
        };

    const CAF = window.cancelAnimationFrame
        ? window.cancelAnimationFrame.bind(window)
        : clearTimeout;

    let smoothYaw = 0;
    let lastFrameTs = 0;

    function driveFrame() {
        rafId = RAF(driveFrame);

        if (!window.pushback || !pushback.pushBackState) {
            lastFrameTs = 0;
            return;
        }

        const now = performance.now();

        let dt = lastFrameTs
            ? (now - lastFrameTs) / 1000
            : 1 / 60;

        lastFrameTs = now;

        if (!(dt > 0) || dt > 0.1) {
            dt = 1 / 60;
        }

        const speed = num(pushback.speed, 0);
        const yawIn = Math.max(
            -1,
            Math.min(1, num(pushback.yaw, 0))
        );

        // 快速跟随输入，尽量消除转向延迟。
        const inputAlpha = 1 - Math.exp(-INPUT_RESPONSE * dt);

        smoothYaw += (yawIn - smoothYaw) * inputAlpha;

        if (Math.abs(smoothYaw) < TURN_DEADZONE) {
            smoothYaw = 0;
        }

        // 非线性转向曲线：低舵量温和放大，高舵量保持原比例。
        // 例如 0.02 输入 => 约 0.053 * 12°/s ≈ 0.65°/s。
        const steerMag = Math.min(1, Math.abs(smoothYaw));
        const shapedYaw =
            (smoothYaw < 0 ? -1 : 1) *
            Math.pow(steerMag, STEER_CURVE);

        const yawRate =
            shapedYaw * TURN_RATE_RAD * YAW_SIGN;

        applyYawRate(yawRate, dt);

        // 转向之后再按新航向设置速度，避免轮胎侧滑把机身顶得左右摆。
        applyVelocity(speed, matrixHeadingDeg(getObject3d()));

        // 牵引车转向动画与实际转向量同步（同样使用放大后的舵量）。
        try {
            geofs.animation.values.yawPushback =
                shapedYaw * STEER_ANIM_SCALE;
        } catch (e) {}
    }

    function startDriveLoop() {
        if (rafId) return;

        lastFrameTs = 0;
        rafId = RAF(driveFrame);
    }

    function stopDriveLoop() {
        if (rafId) {
            CAF(rafId);
            rafId = null;
        }

        lastFrameTs = 0;
        smoothYaw = 0;
        pushback._targetHeading = null;

        applyYawRate(0);

        try {
            geofs.animation.values.yawPushback = 0;
        } catch (e) {}
    }

    /* ======================================================================
       数据加载：多镜像 + 本地缓存
       ====================================================================== */
    async function fetchJson(url, timeoutMs = 9000) {
        const ctrl = typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;

        const timer = ctrl
            ? setTimeout(() => ctrl.abort(), timeoutMs)
            : null;

        try {
            const res = await fetch(
                url,
                ctrl
                    ? { signal: ctrl.signal, cache: 'no-store' }
                    : {}
            );

            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }

            return await res.json();
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function fetchFirst(urls) {
        for (const url of urls) {
            try {
                const data = await fetchJson(url);
                console.log('[pushback] 数据加载成功:', url);
                return data;
            } catch (e) {
                console.warn(
                    '[pushback] 镜像失败:',
                    url,
                    e && e.message
                );
            }
        }

        return null;
    }

    function loadCache() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return null;

            const obj = JSON.parse(raw);

            if (!obj || !obj.info || !obj.models) {
                return null;
            }

            if (Date.now() - (obj.at || 0) >
                30 * 24 * 3600 * 1000) {
                return null;
            }

            return obj;
        } catch (e) {
            return null;
        }
    }

    function saveCache(info, models) {
        try {
            localStorage.setItem(
                CACHE_KEY,
                JSON.stringify({
                    info: info,
                    models: models,
                    at: Date.now()
                })
            );
        } catch (e) {}
    }

    async function getData() {
        // 先使用本地缓存。
        const cached = loadCache();

        if (cached) {
            pushbackInfo = cached.info;
            pushbackModels = cached.models;
            pushback.dataReady = true;
            console.log('[pushback] 使用本地缓存数据');
        }

        const [info, models] = await Promise.all([
            fetchFirst(DATA_INFO_URLS),
            fetchFirst(DATA_MODEL_URLS)
        ]);

        if (info) pushbackInfo = info;
        if (models) pushbackModels = models;

        if (!info || !models) {
            if (!pushback.dataReady) {
                pushbackInfo = pushbackInfo || {};
                pushbackModels = pushbackModels || {};
            }

            console.warn(
                '[pushback] 部分数据没拿到，牵引车可能无法加载'
            );
        }

        pushback.dataReady = !!(
            pushbackInfo &&
            pushbackModels &&
            Object.keys(pushbackInfo).length &&
            Object.keys(pushbackModels).length
        );

        if (info && models) {
            saveCache(info, models);
        }

        console.log(
            '[pushback] dataReady =',
            pushback.dataReady,
            '机型数 =',
            pushbackInfo ? Object.keys(pushbackInfo).length : 0
        );
    }

    /* ======================================================================
       main
       ====================================================================== */
    function main() {
        window.pushback = window.pushback || {};

        pushback.speed = 0;
        pushback.yaw = 0;
        pushback.pushBackState = false;
        pushback.defaultYaw = 0;
        pushback._brakeWatcher = null;
        pushback._completing = false;
        pushback._targetHeading = null;

        installRenderHook();

        pushback.dataReady = !!(
            pushbackInfo &&
            pushbackModels &&
            Object.keys(pushbackInfo || {}).length &&
            Object.keys(pushbackModels || {}).length
        );

        /* ---------- 速度 / 转向 API ---------- */
        pushback.startBack = function (mps) {
            pushback.speed = num(mps, 0);
            startDriveLoop();
        };

        pushback.startYaw = function (ratio) {
            pushback.yaw = Math.max(
                -1,
                Math.min(1, num(ratio, 0))
            );
            startDriveLoop();
        };

        pushback.pushBack = function (dir) {
            applyVelocity(num(dir, 0));
        };

        pushback.stopBack = function () {
            stopDriveLoop();

            pushback.speed = 0;
            pushback.yaw = 0;

            applyVelocity(0);
            applyYawRate(0);

            try {
                geofs.animation.values.yawPushback = 0;
            } catch (e) {}
        };

        /* ---------- 面板 / 状态 ---------- */
        let panelElement = null;
        let _parkingBrakeOn = true;
        let _engineWatcherActive = false;

        function setStatus(text, color) {
            const el = document.getElementById('pb-status');
            if (!el) return;

            el.innerText = text;
            el.style.color = color || '#00a1ff';
        }

        function rampSpeedTo(targetSliderVal, msPerStep, onDone) {
            const sI = document.getElementById('i-speed');

            if (!sI) {
                onDone && onDone();
                return;
            }

            let sv = parseFloat(sI.value);
            const step = targetSliderVal > sv ? 1 : -1;

            const ci = setInterval(() => {
                sv += step;
                sI.value = sv;
                sI.oninput();

                if (
                    (step > 0 && sv >= targetSliderVal) ||
                    (step < 0 && sv <= targetSliderVal)
                ) {
                    clearInterval(ci);
                    sI.value = targetSliderVal;
                    sI.oninput();
                    onDone && onDone();
                }
            }, msPerStep);
        }

        function _destroyTug() {
            try {
                geofs.animation.values.pushBackTruck = 0;
            } catch (e) {}

            try {
                if (geofs.aircraft.instance.parts.pushbackTruck) {
                    geofs.aircraft.instance.parts
                        .pushbackTruck.object3d.destroy();
                }
            } catch (e) {}

            pushback.revertUpdate();
            pushback.stopBack();
        }

        function _finalizeEnd(graceful) {
            pushback._completing = false;

            _destroyTug();

            const btn = document.getElementById('pb-toggle');
            const centerRow =
                document.getElementById('pb-center-row');

            if (btn) {
                btn.innerText = 'REQUEST PUSHBACK';
                btn.style.background = '#00a1ff';
            }

            if (centerRow) {
                centerRow.style.display = 'none';
            }

            _removeKeybinds();

            if (graceful) {
                setStatus(
                    'PUSHBACK COMPLETE — START ENGINES',
                    '#00c864'
                );
                startEngineWatcher();
            } else {
                setStatus('STANDBY', '#aaa');
            }
        }

        function _endPushback(graceful) {
            if (pushback._brakeWatcher) {
                clearInterval(pushback._brakeWatcher);
            }

            pushback.pushBackState = false;

            if (!graceful) {
                VO.cancel();
                VO.speak('Pushback aborted. Disconnecting.');
                _finalizeEnd(false);
                return;
            }

            pushback._completing = true;

            VO.cancel();
            VO.speak('Slowing down.');
            VO.speak(
                'Pushback complete. Clear to start engines.',
                2000
            );

            setStatus('DECELERATING…', '#ffa500');

            rampSpeedTo(40, 40, () => {
                _finalizeEnd(true);
            });
        }

        pushback._endPushback = _endPushback;

        /* ---------- 键盘 ---------- */
        function _onKeyDown(e) {
            if (
                e.target &&
                (
                    e.target.tagName === 'INPUT' ||
                    e.target.tagName === 'TEXTAREA'
                )
            ) {
                return;
            }

            if (e.key === ';') {
                e.preventDefault();

                _parkingBrakeOn = !_parkingBrakeOn;

                if (_parkingBrakeOn) {
                    geofs.aircraft.instance.setup
                        .contactProperties.wheel.lockSpeed =
                        defaultFriction || 1;

                    setStatus(
                        'PARKING BRAKE SET',
                        '#ffa500'
                    );
                } else {
                    geofs.aircraft.instance.setup
                        .contactProperties.wheel.lockSpeed = 0.5;

                    setStatus(
                        'PARKING BRAKE RELEASED',
                        '#00ff99'
                    );
                }
            }

            if (e.key === 'e' || e.key === 'E') {
                if (
                    pushback.pushBackState ||
                    pushback._completing
                ) {
                    e.preventDefault();
                    e.stopPropagation();

                    try {
                        geofs.aircraft.instance.engine.start();
                    } catch (err) {}

                    try {
                        geofs.animation.values.engineOn = 1;
                    } catch (err) {}
                }
            }
        }

        function _addKeybinds() {
            document.addEventListener(
                'keydown',
                _onKeyDown,
                true
            );
        }

        function _removeKeybinds() {
            document.removeEventListener(
                'keydown',
                _onKeyDown,
                true
            );
        }

        function startEngineWatcher() {
            if (_engineWatcherActive) return;

            _engineWatcherActive = true;
            let _prev = false;

            const _ei = setInterval(() => {
                try {
                    const on =
                        geofs.animation.values.engineOn > 0 ||
                        geofs.animation.values.engine1On > 0 ||
                        geofs.animation.values.n1 > 5;

                    if (on && !_prev) {
                        clearInterval(_ei);
                        _engineWatcherActive = false;

                        VO.cancel();
                        VO.speak(
                            'Ground crew disconnecting. Headset out.'
                        );
                        VO.speak(
                            'Have a safe flight. See you next time.',
                            2200
                        );

                        setStatus(
                            'HAVE A NICE FLIGHT',
                            '#00c864'
                        );
                    }

                    _prev = !!on;
                } catch (e) {}
            }, 500);

            setTimeout(() => {
                clearInterval(_ei);
                _engineWatcherActive = false;
            }, 600000);
        }

        /* ---------- 面板 ---------- */
        function createModernPanel() {
            if (panelElement) {
                panelElement.style.display =
                    (panelElement.style.display === 'none')
                        ? 'block'
                        : 'none';
                return;
            }

            panelElement = document.createElement('div');
            panelElement.id = 'pb-modern-panel';

            panelElement.style.cssText = `
                position: fixed; top: 120px; right: 20px; width: 270px;
                background: rgba(10, 10, 10, 0.52); backdrop-filter: blur(6px);
                border: 1px solid rgba(255,255,255,0.15); color: white;
                z-index: 10000; font-family: 'Segoe UI', sans-serif;
                border-radius: 2px; box-shadow: 0 12px 32px rgba(0,0,0,0.6);
                user-select: none;
            `;

            panelElement.innerHTML = `
                <div style="background:rgba(0,161,255,0.72);padding:7px 12px;display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-weight:bold;letter-spacing:1.5px;font-size:11px;">✈ PUSHBACK SYSTEM</span>
                    <span id="closePB" style="cursor:pointer;font-size:14px;">✕</span>
                </div>
                <div style="background:rgba(0,0,0,0.4);padding:5px 12px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:center;">
                    <span id="pb-status" style="font-size:10px;letter-spacing:1px;color:#aaa;">STANDBY</span>
                </div>
                <div style="padding:14px;display:flex;flex-direction:column;gap:13px;">
                    <button id="pb-toggle" style="width:100%;background:#00a1ff;border:none;color:white;padding:10px;font-weight:bold;cursor:pointer;font-size:11px;letter-spacing:1px;border-radius:2px;transition:background 0.2s;">REQUEST PUSHBACK</button>
                    <div style="background:rgba(255,255,255,0.04);padding:9px;border-radius:2px;">
                        <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:6px;color:#ccc;">
                            <span>TUG SPEED</span>
                            <span id="v-speed" style="color:#00a1ff;font-weight:bold;">0.00 m/s</span>
                        </div>
                        <input type="range" id="i-speed" min="0" max="80" value="20" style="width:100%;cursor:pointer;accent-color:#00a1ff;">
                        <div style="display:flex;justify-content:space-between;font-size:9px;color:#555;margin-top:4px;">
                            <span>◀ REVERSE</span><span>0</span><span>FORWARD ▶</span>
                        </div>
                    </div>
                    <div style="background:rgba(255,255,255,0.04);padding:9px;border-radius:2px;">
                        <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:6px;color:#ccc;">
                            <span>STEERING</span>
                            <span id="v-yaw" style="color:#00a1ff;font-weight:bold;">0.00</span>
                        </div>
                        <input type="range" id="i-yaw" min="0" max="100" value="50" style="width:100%;cursor:pointer;accent-color:#00a1ff;">
                        <div style="display:flex;justify-content:space-between;font-size:9px;color:#555;margin-top:4px;">
                            <span>◀ LEFT</span><span>CENTER</span><span>RIGHT ▶</span>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                        <button id="pb-forward" style="background:transparent;border:1px solid #00a1ff;color:#00a1ff;padding:7px;font-size:10px;cursor:pointer;border-radius:2px;letter-spacing:1px;">▲ FORWARD</button>
                        <button id="pb-reverse" style="background:transparent;border:1px solid #00a1ff;color:#00a1ff;padding:7px;font-size:10px;cursor:pointer;border-radius:2px;letter-spacing:1px;">▼ REVERSE</button>
                    </div>
                    <div id="pb-center-row" style="display:none;gap:8px;grid-template-columns:1fr 1fr;">
                        <button id="pb-center" style="background:transparent;border:1px solid #ffa500;color:#ffa500;padding:7px;font-size:10px;cursor:pointer;border-radius:2px;letter-spacing:1px;">⟳ CENTER</button>
                        <button id="pb-complete" style="background:rgba(0,200,100,0.15);border:1px solid #00c864;color:#00c864;padding:7px;font-size:10px;cursor:pointer;border-radius:2px;letter-spacing:1px;">✔ COMPLETE</button>
                    </div>
                    <div style="font-size:9px;color:#555;text-align:center;border-top:1px solid rgba(255,255,255,0.07);padding-top:9px;">
                        [;] PARKING BRAKE &nbsp;·&nbsp; [E] ENGINE START
                    </div>
                </div>
            `;

            document.body.appendChild(panelElement);

            const d = document;
            const yI = d.getElementById('i-yaw');
            const sI = d.getElementById('i-speed');
            const btn = d.getElementById('pb-toggle');
            const yV = d.getElementById('v-yaw');
            const sV = d.getElementById('v-speed');
            const centerRow = d.getElementById('pb-center-row');
            const centerBtn = d.getElementById('pb-center');
            const completeBtn = d.getElementById('pb-complete');

            btn.onclick = async function () {
                if (
                    pushback.pushBackState === false &&
                    !pushback._completing
                ) {
                    if (!pushback.checkAircraft(
                        geofs.aircraft.instance.id
                    )) {
                        return;
                    }

                    VO.cancel();
                    VO.speak(
                        'Headset connected. Left wing clear.'
                    );
                    VO.speak('Right wing clear.', 1600);
                    VO.speak(
                        'Ready to push. Release parking brake.',
                        3200
                    );

                    setStatus(
                        'AWAITING BRAKE RELEASE — PRESS ; TO RELEASE',
                        '#ffa500'
                    );

                    _parkingBrakeOn = true;
                    _addKeybinds();

                    const brakeWatcher = setInterval(async () => {
                        const brakeOn =
                            geofs.aircraft.instance.setup
                                .contactProperties.wheel.lockSpeed > 0.4;

                        if (!brakeOn) {
                            clearInterval(brakeWatcher);

                            pushback.setUpdate();
                            pushback.addPushBackTruck();

                            pushback.pushBackState = true;

                            try {
                                geofs.animation.values.pushBackTruck = 1;
                            } catch (e) {}

                            defaultFriction =
                                geofs.aircraft.instance.setup
                                    .contactProperties.wheel.lockSpeed || 1;

                            geofs.aircraft.instance.setup
                                .contactProperties.wheel.lockSpeed = 0.5;

                            btn.innerText = 'END PUSHBACK';
                            btn.style.background = '#c0392b';

                            centerRow.style.display = 'grid';

                            setStatus(
                                'PUSHING BACK',
                                '#00ff99'
                            );

                            startDriveLoop();

                            VO.speak(
                                'Brakes released. Start pushback.'
                            );
                        }
                    }, 250);

                    pushback._brakeWatcher = brakeWatcher;
                } else {
                    _endPushback(false);
                }
            };

            centerBtn.onclick = function () {
                VO.cancel();
                VO.speak('Steering to center.');

                let steps = 30;
                let current = parseFloat(yI.value);
                const delta = (50 - current) / steps;

                const ci = setInterval(() => {
                    current += delta;
                    yI.value = Math.round(current);
                    yI.oninput();

                    steps--;

                    if (steps <= 0) {
                        yI.value = 50;
                        yI.oninput();
                        clearInterval(ci);
                    }
                }, 33);
            };

            completeBtn.onclick = function () {
                if (pushback._completing) return;

                pushback.pushBackState = false;
                _endPushback(true);
            };

            // 舵量：-1..1，右为正。
            yI.oninput = function () {
                const v = (this.value - 50) / 50;
                yV.innerText = v.toFixed(2);
                pushback.startYaw(v);
            };

            // 速度：0..80 滑块 → -MAX..+MAX m/s。
            sI.oninput = function () {
                const v =
                    (parseFloat(this.value) - 40) / 40 *
                    MAX_SPEED_MPS;

                sV.innerText =
                    (v >= 0 ? '+' : '') + v.toFixed(2) + ' m/s';

                pushback.startBack(v);
            };

            d.getElementById('pb-forward').onclick = () => {
                sI.value = 60;
                sI.oninput();
            };

            d.getElementById('pb-reverse').onclick = () => {
                sI.value = 20;
                sI.oninput();
            };

            d.getElementById('closePB').onclick = () => {
                panelElement.style.display = 'none';
            };

            // 初始化显示。
            sI.oninput();
            yI.oninput();
        }

        /* ---------- 工具车：位置 / 动画 ---------- */
        pushback.checkAircraft = function (id) {
            if (!pushback.dataReady) {
                setStatus(
                    'TUG DATA LOADING… 等几秒再点（或检查网络）',
                    '#ffa500'
                );

                if (!pushback._reloading) {
                    pushback._reloading = true;

                    getData().then(function () {
                        pushback._reloading = false;

                        if (pushback.dataReady) {
                            setStatus(
                                'TUG DATA READY',
                                '#00ff99'
                            );
                        }
                    });
                }

                return false;
            }

            return true;
        };

        // 不再改机模的前轮转向动画。
        // GeoFS 的 'steering' 动画会连带旋转前轮的碰撞点/轮胎方向，
        // 而我们是用脚本直接锁航向的；两者同时作用会让轮胎横滑、
        // 机身左右摇摆。这里只读取 ratio 给牵引车做视觉转向。
        // 方向舵的 'yaw' 也完全不动。
        pushback.setUpdate = function () {
            try {
                installRenderHook();

                pushback.defaultYaw = 0;
                pushback._targetHeading = null;

                const parts =
                    geofs.aircraft.instance.setup.parts || [];

                for (let i = 0; i < parts.length; i++) {
                    const anims = parts[i].animations || [];

                    for (let j = 0; j < anims.length; j++) {
                        const anim = anims[j];

                        const isSteering = Array.isArray(anim.value)
                            ? anim.value.indexOf('steering') >= 0
                            : anim.value === 'steering';

                        if (isSteering && anim.ratio) {
                            pushback.defaultYaw = anim.ratio;
                        }
                    }
                }

                if (!pushback.defaultYaw) {
                    pushback.defaultYaw = 30;
                }
            } catch (e) {}
        };

        // 还原轮子摩擦。
        pushback.revertUpdate = function () {
            try {
                clearInterval(pushback._brakeWatcher);

                geofs.aircraft.instance.setup
                    .contactProperties.wheel.lockSpeed =
                    defaultFriction;
            } catch (e) {}
        };

        /* ---------- 添加牵引车 ---------- */
        function modelCandidates(modelPath) {
            const p = String(modelPath || '');
            const seg = p.split('/');
            const list = [];

            if (seg.length >= 4) {
                const user = seg[0];
                const repo = seg[1];
                const branch = seg[2];
                const rest = seg.slice(3).join('/');

                list.push({
                    base: 'https://cdn.jsdelivr.net/gh/',
                    path: user + '/' + repo + '@' + branch + '/' + rest
                });

                list.push({
                    base: 'https://gcore.jsdelivr.net/gh/',
                    path: user + '/' + repo + '@' + branch + '/' + rest
                });
            }

            list.push({
                base: 'https://raw.githubusercontent.com/',
                path: p
            });

            return list;
        }

        async function pickModelSource(modelPath) {
            const cands = modelCandidates(modelPath);

            for (const c of cands) {
                try {
                    const res = await fetch(
                        c.base + c.path,
                        {
                            method: 'HEAD',
                            cache: 'no-store'
                        }
                    );

                    if (res.ok) {
                        console.log(
                            '[pushback] 模型源可用:',
                            c.base
                        );
                        return c;
                    }
                } catch (e) {}
            }

            console.warn(
                '[pushback] 所有模型源探测失败，使用第一个（可能被墙）'
            );

            return cands[0];
        }

        pushback.addPushBackTruck = function (attempt) {
            attempt = attempt || 1;

            (async function () {
                try {
                    const inst = geofs.aircraft.instance;
                    const id = inst && inst.id;
                    const bag = pushbackInfo || {};

                    let info = bag[id];

                    if (!info) {
                        for (const k in bag) {
                            if (
                                bag[k] &&
                                bag[k].model !== undefined
                            ) {
                                info = bag[k];
                                break;
                            }
                        }

                        if (info) {
                            console.warn(
                                '[pushback] 机型 ' + id +
                                ' 没有专属配置，使用兜底数据'
                            );
                        }
                    }

                    if (!info) {
                        console.warn(
                            '[pushback] 没有可用的牵引车配置，稍后重试',
                            attempt
                        );

                        if (attempt < 3) {
                            setTimeout(
                                function () {
                                    pushback.addPushBackTruck(
                                        attempt + 1
                                    );
                                },
                                1500
                            );
                        }

                        return;
                    }

                    // 模型：兼容对象键名与数组下标。
                    let modelPath = pushbackModels
                        ? pushbackModels[info.model]
                        : null;

                    const keys = pushbackModels
                        ? Object.keys(pushbackModels)
                        : [];

                    if (
                        !modelPath &&
                        /^\d+$/.test(String(info.model)) &&
                        keys.length
                    ) {
                        modelPath =
                            pushbackModels[keys[Number(info.model)]];
                    }

                    if (!modelPath && keys.length) {
                        modelPath = pushbackModels[keys[0]];

                        console.warn(
                            '[pushback] 模型 ' + info.model +
                            ' 找不到，改用第一个模型兜底'
                        );
                    }

                    if (!modelPath) {
                        console.warn(
                            '[pushback] 牵引车模型数据还没到，稍后重试',
                            attempt
                        );

                        if (attempt < 3) {
                            setTimeout(
                                function () {
                                    pushback.addPushBackTruck(
                                        attempt + 1
                                    );
                                },
                                1500
                            );
                        }

                        return;
                    }

                    // 位置：必须是 3 元数组。
                    let pos = info.pos;

                    if (!Array.isArray(pos) || pos.length !== 3) {
                        pos = [0, 0, 8];

                        console.warn(
                            '[pushback] 机型缺少 pos，使用兜底位置',
                            pos
                        );
                    }

                    const src = await pickModelSource(modelPath);

                    const part = {
                        name: 'pushbackTruck',
                        model: src.path,
                        position: pos,
                        animations: [
                            {
                                type: 'rotate',
                                axis: 'Z',
                                value: 'yawPushback',
                                ratio: pushback.defaultYaw
                            },
                            {
                                value: 'pushBackTruck',
                                type: 'show'
                            },
                            {
                                type: 'rotate',
                                value: 'atilt',
                                axis: 'X',
                                ratio: -1
                            }
                        ],
                        rotation: [0, 0, 0]
                    };

                    // 清掉可能残留的旧车，避免叠两台。
                    try {
                        if (
                            inst.parts &&
                            inst.parts.pushbackTruck
                        ) {
                            inst.parts.pushbackTruck
                                .object3d.destroy();

                            delete inst.parts.pushbackTruck;
                        }
                    } catch (e) {}

                    inst.addParts(
                        [part],
                        src.base,
                        1,
                        'Zup'
                    );

                    console.log(
                        '[pushback] 牵引车已挂载 model=' +
                        info.model +
                        ' base=' +
                        src.base +
                        ' pos=' +
                        JSON.stringify(pos)
                    );

                    setTimeout(function () {
                        try {
                            if (
                                !inst.parts ||
                                !inst.parts.pushbackTruck
                            ) {
                                console.warn(
                                    '[pushback] 牵引车没有挂上，重试',
                                    attempt
                                );

                                if (attempt < 3) {
                                    pushback.addPushBackTruck(
                                        attempt + 1
                                    );
                                }
                            }
                        } catch (e) {}
                    }, 900);

                } catch (e) {
                    console.warn(
                        '[pushback] 牵引车加载异常',
                        e
                    );

                    if (attempt < 3) {
                        setTimeout(
                            function () {
                                pushback.addPushBackTruck(
                                    attempt + 1
                                );
                            },
                            1500
                        );
                    }
                }
            })();
        };

        /* ---------- 把 PUSHBACK 按钮挂到自动驾驶栏 ---------- */
        const bar = document.getElementsByClassName(
            'geofs-autopilot-bar'
        );

        if (bar && bar[0]) {
            const btnMain = document.createElement('div');

            btnMain.classList.add('control-pad');
            btnMain.id = 'pushbackButtonMain';

            btnMain.style.cssText =
                'width: 90px;height: 25px;margin: 0px 10px;' +
                'border-radius: 15px;outline: none;';

            btnMain.innerHTML =
                '<div style="line-height: 27px;font-size: 12px !important;' +
                'pointer-events: none;color: #FFF;text-align: center;">' +
                'PUSHBACK</div>';

            bar[0].append(btnMain);

            btnMain.onclick = function () {
                createModernPanel();
            };

        } else {
            // 兜底：直接把小按钮放右下角。
            const btnMain = document.createElement('div');

            btnMain.id = 'pushbackButtonMain';

            btnMain.style.cssText =
                'position:fixed;right:20px;bottom:20px;' +
                'z-index:9999;background:#00a1ff;color:#fff;' +
                'padding:8px 14px;border-radius:15px;' +
                'cursor:pointer;font:12px Segoe UI;';

            btnMain.innerText = 'PUSHBACK';

            btnMain.onclick = function () {
                createModernPanel();
            };

            document.body.appendChild(btnMain);
        }
    }

    /* ======================================================================
       启动：等 GeoFS 加载完
       ====================================================================== */
    const itv = setInterval(function () {
        try {
            if (window.ui && window.flight) {
                main();
                getData();
                clearInterval(itv);
            }
        } catch (e) {}
    }, 500);

})();
