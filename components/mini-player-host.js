"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiniPlayerHost = MiniPlayerHost;
var vector_icons_1 = require("@expo/vector-icons");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_video_1 = require("expo-video");
var playback_provider_1 = require("@/components/playback-provider");
var streaming_theme_1 = require("@/constants/streaming-theme");
var mini_player_1 = require("@/services/mini-player");
var PLAYER_FALLBACK = {
    currentTime: 0,
    play: function () { },
    pause: function () { },
    addListener: function () {
        return { remove: function () { } };
    },
};
function MiniPlayerHost() {
    var _this = this;
    var CARD_WIDTH = 220;
    var CARD_HEIGHT = 170;
    var CARD_MARGIN = 12;
    var BOTTOM_GAP = 84;
    var router = (0, expo_router_1.useRouter)();
    var pathname = (0, expo_router_1.usePathname)();
    var _a = (0, react_native_1.useWindowDimensions)(), width = _a.width, height = _a.height;
    var videoViewRef = (0, react_1.useRef)(null);
    var isStartingPipRef = (0, react_1.useRef)(false);
    var hasInitialCardPositionRef = (0, react_1.useRef)(false);
    var cardPosition = (0, react_1.useRef)(new react_native_1.Animated.ValueXY({ x: 0, y: 0 })).current;
    var player = (0, playback_provider_1.usePlayback)().player;
    var playbackPlayer = player !== null && player !== void 0 ? player : PLAYER_FALLBACK;
    var _b = (0, react_1.useState)(null), miniPlayerState = _b[0], setMiniPlayerStateLocal = _b[1];
    var _c = (0, react_1.useState)(true), isPlaying = _c[0], setIsPlaying = _c[1];
    var _d = (0, react_1.useState)(true), isMiniLoading = _d[0], setIsMiniLoading = _d[1];
    var _e = (0, react_1.useState)(false), hasMiniFrame = _e[0], setHasMiniFrame = _e[1];
    var hasInitializedRef = (0, react_1.useRef)(false);
    var positionRef = (0, react_1.useRef)(0);
    var clamp = function (value, min, max) { return Math.min(Math.max(value, min), max); };
    var getBounds = function () {
        var minX = CARD_MARGIN;
        var maxX = Math.max(CARD_MARGIN, width - CARD_WIDTH - CARD_MARGIN);
        var minY = CARD_MARGIN;
        var maxY = Math.max(CARD_MARGIN, height - CARD_HEIGHT - BOTTOM_GAP);
        return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    };
    var applyCardPosition = function (x, y) {
        cardPosition.setValue({ x: x, y: y });
    };
    var startSystemPip = function (showError) { return __awaiter(_this, void 0, void 0, function () {
        var supported, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (react_native_1.Platform.OS !== 'android')
                        return [2 /*return*/];
                    if (isStartingPipRef.current)
                        return [2 /*return*/];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, (0, expo_video_1.isPictureInPictureSupported)()];
                case 2:
                    supported = _c.sent();
                    if (!supported) {
                        if (showError) {
                            react_native_1.Alert.alert('PiP indisponivel', 'Este dispositivo nao suporta Picture in Picture para este player.');
                        }
                        return [2 /*return*/];
                    }
                    isStartingPipRef.current = true;
                    return [4 /*yield*/, ((_b = videoViewRef.current) === null || _b === void 0 ? void 0 : _b.startPictureInPicture())];
                case 3:
                    _c.sent();
                    return [3 /*break*/, 6];
                case 4:
                    _a = _c.sent();
                    if (showError) {
                        react_native_1.Alert.alert('Falha ao iniciar PiP', 'Nao foi possivel abrir o PiP do sistema agora.');
                    }
                    return [3 /*break*/, 6];
                case 5:
                    setTimeout(function () {
                        isStartingPipRef.current = false;
                    }, 500);
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); };
    var stopSystemPip = function () { return __awaiter(_this, void 0, void 0, function () {
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (react_native_1.Platform.OS !== 'android')
                        return [2 /*return*/];
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, ((_c = (_b = videoViewRef.current) === null || _b === void 0 ? void 0 : _b.stopPictureInPicture) === null || _c === void 0 ? void 0 : _c.call(_b))];
                case 2:
                    _d.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _d.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); };
    var panResponder = (0, react_1.useMemo)(function () {
        return react_native_1.PanResponder.create({
            onStartShouldSetPanResponder: function () { return false; },
            onStartShouldSetPanResponderCapture: function () { return false; },
            onMoveShouldSetPanResponder: function (_, gestureState) {
                return Math.abs(gestureState.dx) > 4 || Math.abs(gestureState.dy) > 4;
            },
            onMoveShouldSetPanResponderCapture: function (_, gestureState) {
                return Math.abs(gestureState.dx) > 4 || Math.abs(gestureState.dy) > 4;
            },
            onPanResponderTerminationRequest: function () { return false; },
            onPanResponderGrant: function () {
                cardPosition.stopAnimation(function (value) {
                    cardPosition.setOffset({ x: value.x, y: value.y });
                    cardPosition.setValue({ x: 0, y: 0 });
                });
            },
            onPanResponderMove: react_native_1.Animated.event([null, { dx: cardPosition.x, dy: cardPosition.y }], {
                useNativeDriver: false,
            }),
            onPanResponderRelease: function (_, gestureState) {
                cardPosition.flattenOffset();
                cardPosition.stopAnimation(function (value) {
                    var _a = getBounds(), minX = _a.minX, maxX = _a.maxX, minY = _a.minY, maxY = _a.maxY;
                    var swipedOut = Math.abs(gestureState.dx) > 120 &&
                        Math.abs(gestureState.vx) > 0.25 &&
                        (value.x < minX - 20 || value.x > maxX + 20);
                    if (swipedOut) {
                        var targetX = value.x < minX ? -CARD_WIDTH - 40 : width + 40;
                        react_native_1.Animated.timing(cardPosition, {
                            toValue: { x: targetX, y: clamp(value.y, minY, maxY) },
                            duration: 170,
                            useNativeDriver: false,
                        }).start(function () {
                            handleClose();
                        });
                        return;
                    }
                    var clampedY = clamp(value.y, minY, maxY);
                    var middleX = (minX + maxX) / 2;
                    var snapX = value.x <= middleX ? minX : maxX;
                    react_native_1.Animated.spring(cardPosition, {
                        toValue: { x: snapX, y: clampedY },
                        useNativeDriver: false,
                        bounciness: 4,
                    }).start();
                });
            },
        });
    }, [height, width]);
    (0, react_1.useEffect)(function () {
        var unsubscribe = (0, mini_player_1.subscribeMiniPlayer)(function (nextState) {
            setMiniPlayerStateLocal(nextState);
        });
        return unsubscribe;
    }, []);
    (0, react_1.useEffect)(function () {
        if (!(miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url)) {
            hasInitializedRef.current = false;
            return;
        }
        // Reset flag ao trocar de URL
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            setHasMiniFrame(false);
            setIsMiniLoading(true);
            // Sincroniza para o tempo armazenado do mini-player apenas na PRIMEIRA inicialização
            var startPositionSec = (miniPlayerState.positionMs || 0) / 1000;
            if (startPositionSec > 0) {
                playbackPlayer.currentTime = startPositionSec;
                positionRef.current = miniPlayerState.positionMs || 0;
            }
            playbackPlayer.play();
            setIsPlaying(true);
        }
    }, [miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url]);
    (0, react_1.useEffect)(function () {
        if (!(miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url))
            return;
        var subscriptions = [
            playbackPlayer.addListener('statusChange', function (_a) {
                var status = _a.status;
                setIsMiniLoading(!hasMiniFrame && (status === 'idle' || status === 'loading'));
            }),
            playbackPlayer.addListener('playingChange', function (_a) {
                var nowPlaying = _a.isPlaying;
                setIsPlaying(nowPlaying);
            }),
            playbackPlayer.addListener('sourceLoad', function () {
                if (playbackPlayer.currentTime > 0) {
                    setHasMiniFrame(true);
                    setIsMiniLoading(false);
                }
                playbackPlayer.play();
            }),
            playbackPlayer.addListener('timeUpdate', function (_a) {
                var currentTime = _a.currentTime;
                var positionMs = Math.max(0, Math.floor(currentTime * 1000));
                positionRef.current = positionMs;
                // Atualiza posição no estado compartilhado (importante para expandir sem perder progresso)
                (0, mini_player_1.setMiniPlayerState)(function (prev) { return (prev ? __assign(__assign({}, prev), { positionMs: positionMs }) : prev); });
                if (currentTime > 0 && !hasMiniFrame) {
                    setHasMiniFrame(true);
                    setIsMiniLoading(false);
                }
            })
        ];
        return function () {
            subscriptions.forEach(function (sub) { return sub.remove(); });
        };
    }, [miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url, hasMiniFrame]);
    (0, react_1.useEffect)(function () {
        if (!(miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url)) {
            hasInitialCardPositionRef.current = false;
            return;
        }
        var _a = getBounds(), minX = _a.minX, maxX = _a.maxX, minY = _a.minY, maxY = _a.maxY;
        if (!hasInitialCardPositionRef.current) {
            applyCardPosition(maxX, maxY);
            hasInitialCardPositionRef.current = true;
            return;
        }
        cardPosition.stopAnimation(function (value) {
            applyCardPosition(clamp(value.x, minX, maxX), clamp(value.y, minY, maxY));
        });
    }, [miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url, width, height]);
    // AppState listener REMOVIDO - PiP automático causava bugs
    // O PiP agora é controlado apenas manualmente pelo usuário ou pelo player.tsx
    // Nunca renderiza o mini player por cima da tela principal do player.
    // Isso evita duas VideoView tentando usar o mesmo objeto de player.
    if (String(pathname || '').startsWith('/player')) {
        return null;
    }
    if (!(miniPlayerState === null || miniPlayerState === void 0 ? void 0 : miniPlayerState.url) || !player) {
        return null;
    }
    var handleTogglePlay = function () {
        if (isPlaying) {
            playbackPlayer.pause();
            return;
        }
        playbackPlayer.play();
    };
    var handleClose = function () {
        try {
            playbackPlayer.pause();
        }
        catch (_a) {
            // Ignora falhas de pause em alguns estados do player.
        }
        (0, mini_player_1.clearMiniPlayerState)();
    };
    var handleExpand = function () {
        var precisePositionMs = Math.max(0, Math.floor((playbackPlayer.currentTime || 0) * 1000));
        var lastPositionMs = precisePositionMs || positionRef.current || miniPlayerState.positionMs || 0;
        var snapshot = miniPlayerState;
        // Para o PiP nativo quando expandir
        void stopSystemPip();
        // Pausa o player mas NÃO limpa o estado ainda
        // Deixa o player.tsx tomar controle da reprodução
        try {
            playbackPlayer.pause();
        }
        catch (_a) {
            // ignora
        }
        router.push({
            pathname: '/player',
            params: {
                mode: snapshot.mode,
                title: snapshot.title,
                url: snapshot.url,
                contentId: snapshot.contentId || '',
                seriesId: snapshot.seriesId || '',
                playlistKey: snapshot.playlistKey || '',
                playlistIndex: String(snapshot.playlistIndex || 0),
                startPositionMs: String(lastPositionMs),
            },
        });
        // Limpa o estado após um delay para garantir que a navegação aconteça
        setTimeout(function () {
            (0, mini_player_1.clearMiniPlayerState)();
        }, 300);
    };
    return (<react_native_1.View pointerEvents="box-none" style={styles.wrap}>
      <react_native_1.Animated.View style={[styles.card, cardPosition.getLayout()]} {...panResponder.panHandlers}>
        <react_native_1.TouchableOpacity style={styles.videoTapArea} activeOpacity={0.9} onPress={handleExpand} {...panResponder.panHandlers}>
          <expo_video_1.VideoView ref={videoViewRef} player={player} style={styles.video} pointerEvents="none" contentFit="cover" nativeControls={false} allowsPictureInPicture startsPictureInPictureAutomatically={react_native_1.Platform.OS === 'android'} onFirstFrameRender={function () {
            setHasMiniFrame(true);
            setIsMiniLoading(false);
        }}/>
          {isMiniLoading && (<react_native_1.View style={styles.loadingOverlay} pointerEvents="none">
              <react_native_1.ActivityIndicator size="small" color={streaming_theme_1.StreamingTheme.colors.textPrimary}/>
            </react_native_1.View>)}
        </react_native_1.TouchableOpacity>

        <react_native_1.View style={styles.infoBar}>
          <react_native_1.Text style={styles.title} numberOfLines={1}>
            {miniPlayerState.title || 'Player'}
          </react_native_1.Text>
          <react_native_1.View style={styles.actions}>
            {react_native_1.Platform.OS === 'android' && (<react_native_1.TouchableOpacity style={styles.iconBtn} onPress={function () { return startSystemPip(true); }}>
                <vector_icons_1.MaterialIcons name="picture-in-picture-alt" size={16} color={streaming_theme_1.StreamingTheme.colors.textPrimary}/>
              </react_native_1.TouchableOpacity>)}
            <react_native_1.TouchableOpacity style={styles.iconBtn} onPress={handleExpand}>
              <vector_icons_1.MaterialIcons name="open-in-full" size={16} color={streaming_theme_1.StreamingTheme.colors.textPrimary}/>
            </react_native_1.TouchableOpacity>
            <react_native_1.TouchableOpacity style={styles.iconBtn} onPress={handleTogglePlay}>
              <vector_icons_1.MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={18} color={streaming_theme_1.StreamingTheme.colors.textPrimary}/>
            </react_native_1.TouchableOpacity>
            <react_native_1.TouchableOpacity style={styles.iconBtn} onPress={handleClose}>
              <vector_icons_1.MaterialIcons name="close" size={18} color={streaming_theme_1.StreamingTheme.colors.textPrimary}/>
            </react_native_1.TouchableOpacity>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.Animated.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrap: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { zIndex: 90 }),
    card: {
        position: 'absolute',
        width: 220,
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
        backgroundColor: 'rgba(7,9,15,0.94)',
        elevation: 8,
    },
    videoTapArea: {
        width: '100%',
        aspectRatio: 16 / 9,
        backgroundColor: '#000',
    },
    video: {
        width: '100%',
        height: '100%',
        backgroundColor: '#000',
    },
    loadingOverlay: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.22)' }),
    infoBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 7,
    },
    title: {
        flex: 1,
        color: streaming_theme_1.StreamingTheme.colors.textPrimary,
        fontSize: 12,
        fontWeight: '700',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    iconBtn: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
});
