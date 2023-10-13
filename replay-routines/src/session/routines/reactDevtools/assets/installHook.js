
module.exports.installHookWrapper = function installHookWrapper() {
// As of https://github.com/replayio/react/pull/3
!function(e){var n={};function t(o){if(n[o])return n[o].exports;var r=n[o]={i:o,l:!1,exports:{}};return e[o].call(r.exports,r,r.exports,t),r.l=!0,r.exports}t.m=e,t.c=n,t.d=function(e,n,o){t.o(e,n)||Object.defineProperty(e,n,{enumerable:!0,get:o})},t.r=function(e){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})},t.t=function(e,n){if(1&n&&(e=t(e)),8&n)return e;if(4&n&&"object"==typeof e&&e&&e.__esModule)return e;var o=Object.create(null);if(t.r(o),Object.defineProperty(o,"default",{enumerable:!0,value:e}),2&n&&"string"!=typeof e)for(var r in e)t.d(o,r,function(n){return e[n]}.bind(null,r));return o},t.n=function(e){var n=e&&e.__esModule?function(){return e.default}:function(){return e};return t.d(n,"a",n),n},t.o=function(e,n){return Object.prototype.hasOwnProperty.call(e,n)},t.p="/build/",t(t.s=0)}([function(e,n,t){"use strict";t.r(n),window.hasOwnProperty("__REACT_DEVTOOLS_GLOBAL_HOOK__")||(!function(e){if(e.hasOwnProperty("__REACT_DEVTOOLS_GLOBAL_HOOK__"))return null;let n=console,t={};for(const e in console)t[e]=console[e];let o=null;function r({hideConsoleLogsInStrictMode:e,browserTheme:t}){if(null!==o)return;const r={};o=()=>{for(const e in r)try{n[e]=r[e]}catch(e){}},["error","group","groupCollapsed","info","log","trace","warn"].forEach(o=>{try{const i=r[o]=n[o].__REACT_DEVTOOLS_STRICT_MODE_ORIGINAL_METHOD__?n[o].__REACT_DEVTOOLS_STRICT_MODE_ORIGINAL_METHOD__:n[o],c=(...n)=>{if(!e){let e;switch(o){case"warn":e="light"===t?"rgba(250, 180, 50, 0.75)":"rgba(250, 180, 50, 0.5)";break;case"error":e="light"===t?"rgba(250, 123, 130, 0.75)":"rgba(250, 123, 130, 0.5)";break;case"log":default:e="light"===t?"rgba(125, 125, 125, 0.75)":"rgba(125, 125, 125, 0.5)"}if(!e)throw Error("Console color is not defined");i(...(r=n,c="color: "+e,null==r||0===r.length||"string"==typeof r[0]&&r[0].match(/([^%]|^)(%c)/g)||void 0===c?r:"string"==typeof r[0]&&r[0].match(/([^%]|^)((%%)*)(%([oOdisf]))/g)?["%c"+r[0],c,...r.slice(1)]:[r.reduce((e,n,t)=>{switch(t>0&&(e+=" "),typeof n){case"string":case"boolean":case"symbol":return e+"%s";case"number":return e+(Number.isInteger(n)?"%i":"%f");default:return e+"%o"}},"%c"),c,...r]))}var r,c};c.__REACT_DEVTOOLS_STRICT_MODE_ORIGINAL_METHOD__=i,i.__REACT_DEVTOOLS_STRICT_MODE_OVERRIDE_METHOD__=c,n[o]=c}catch(e){}})}let i=0,c=!1;const u=[],_=[];function l(e){const n=e.stack.split("\n");return n.length>1?n[1]:null}const s={},d=new Map,a={},O=new Map,f=new Map,p={rendererInterfaces:d,listeners:a,backends:f,renderers:O,emit:function(e,n){a[e]&&a[e].map(e=>e(n))},getFiberRoots:function(e){const n=s;return n[e]||(n[e]=new Set),n[e]},inject:function(n){const t=++i;O.set(t,n);const o=c?"deadcode":function(e){try{if("string"==typeof e.version)return e.bundleType>0?"development":"production";const n=Function.prototype.toString;if(e.Mount&&e.Mount._renderNewRootComponent){const t=n.call(e.Mount._renderNewRootComponent);return 0!==t.indexOf("function")?"production":-1!==t.indexOf("storedMeasure")?"development":-1!==t.indexOf("should be a pure function")?-1!==t.indexOf("NODE_ENV")||-1!==t.indexOf("development")||-1!==t.indexOf("true")?"development":-1!==t.indexOf("nextElement")||-1!==t.indexOf("nextComponent")?"unminified":"development":-1!==t.indexOf("nextElement")||-1!==t.indexOf("nextComponent")?"unminified":"outdated"}}catch(e){}return"production"}(n);if(e.hasOwnProperty("__REACT_DEVTOOLS_CONSOLE_FUNCTIONS__")){const{registerRendererWithConsole:t,patchConsoleUsingWindowValues:o}=e.__REACT_DEVTOOLS_CONSOLE_FUNCTIONS__;"function"==typeof t&&"function"==typeof o&&(t(n),o())}const r=e.__REACT_DEVTOOLS_ATTACH__;if("function"==typeof r){const o=r(p,t,n,e);p.rendererInterfaces.set(t,o)}return p.emit("renderer",{id:t,renderer:n,reactBuildType:o}),t},on:function(e,n){a[e]||(a[e]=[]),a[e].push(n)},off:function(e,n){if(!a[e])return;const t=a[e].indexOf(n);-1!==t&&a[e].splice(t,1),a[e].length||delete a[e]},sub:function(e,n){return p.on(e,n),()=>p.off(e,n)},supportsFiber:!0,checkDCE:function(e){try{const n=Function.prototype.toString;n.call(e).indexOf("^_^")>-1&&(c=!0,setTimeout((function(){throw new Error("React is running in production mode, but dead code elimination has not been applied. Read how to correctly configure React for production: https://reactjs.org/link/perf-use-production-build")})))}catch(e){}},onCommitFiberUnmount:function(e,n){const t=d.get(e);null!=t&&t.handleCommitFiberUnmount(n)},onCommitFiberRoot:function(e,n,t){const o=p.getFiberRoots(e),r=n.current,i=o.has(n),c=null==r.memoizedState||null==r.memoizedState.element;i||c?i&&c&&o.delete(n):o.add(n);const u=d.get(e);null!=u&&u.handleCommitFiberRoot(n,t)},onPostCommitFiberRoot:function(e,n){const t=d.get(e);null!=t&&t.handlePostCommitFiberRoot(n)},setStrictMode:function(e,n){const t=d.get(e);if(null!=t)n?t.patchConsoleForStrictMode():t.unpatchConsoleForStrictMode();else if(n){r({hideConsoleLogsInStrictMode:!0===window.__REACT_DEVTOOLS_HIDE_CONSOLE_LOGS_IN_STRICT_MODE__,browserTheme:window.__REACT_DEVTOOLS_BROWSER_THEME__})}else null!==o&&(o(),o=null)},getInternalModuleRanges:function(){return _},registerInternalModuleStart:function(e){const n=l(e);null!==n&&u.push(n)},registerInternalModuleStop:function(e){if(u.length>0){const n=u.pop(),t=l(e);null!==t&&_.push([n,t])}}};Object.defineProperty(e,"__REACT_DEVTOOLS_GLOBAL_HOOK__",{configurable:!1,enumerable:!1,get:()=>p})}(window),window.__REACT_DEVTOOLS_GLOBAL_HOOK__.on("renderer",(function({reactBuildType:e}){window.postMessage({source:"react-devtools-detector",reactBuildType:e},"*")})),window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeObjectCreate=Object.create,window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeMap=Map,window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeWeakMap=WeakMap,window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeSet=Set)}]);

}
