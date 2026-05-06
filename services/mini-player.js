"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeMiniPlayer = exports.clearMiniPlayerState = exports.setMiniPlayerState = exports.getMiniPlayerState = void 0;
var currentMiniPlayerState = null;
var listeners = new Set();
var notify = function () {
    listeners.forEach(function (listener) { return listener(currentMiniPlayerState); });
};
var getMiniPlayerState = function () { return currentMiniPlayerState; };
exports.getMiniPlayerState = getMiniPlayerState;
var setMiniPlayerState = function (nextState) {
    currentMiniPlayerState =
        typeof nextState === 'function'
            ? nextState(currentMiniPlayerState)
            : nextState;
    notify();
};
exports.setMiniPlayerState = setMiniPlayerState;
var clearMiniPlayerState = function () {
    currentMiniPlayerState = null;
    notify();
};
exports.clearMiniPlayerState = clearMiniPlayerState;
var subscribeMiniPlayer = function (listener) {
    listeners.add(listener);
    listener(currentMiniPlayerState);
    return function () {
        listeners.delete(listener);
    };
};
exports.subscribeMiniPlayer = subscribeMiniPlayer;
