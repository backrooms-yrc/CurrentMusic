// 旧版 Android WebView 兼容垫片
// esbuild 只降级「语法」，不会补「内置 API」；mdui 内部用到 replaceAll(Chrome85)、
// 我们用到 Promise.allSettled(Chrome76)，旧引擎上会直接抛错。这里按需补齐。
(function () {
  if (!Promise.allSettled) {
    Promise.allSettled = function (iterable) {
      return Promise.resolve(iterable).then(function (list) {
        return Promise.all(Array.prototype.map.call(list, function (p) {
          return Promise.resolve(p).then(
            function (v) { return { status: 'fulfilled', value: v }; },
            function (e) { return { status: 'rejected', reason: e }; }
          );
        }));
      });
    };
  }
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (find, rep) {
      if (find instanceof RegExp) {
        if (!find.global) throw new TypeError('replaceAll must be called with a global RegExp');
        return this.replace(find, rep);
      }
      var s = String(this), f = String(find), out = '', i = 0, idx;
      if (f === '') {
        for (var k = 0; k <= s.length; k++) {
          out += (typeof rep === 'function' ? rep('', k, s) : rep) + (s[k] || '');
        }
        return out;
      }
      while ((idx = s.indexOf(f, i)) !== -1) {
        out += s.slice(i, idx) + (typeof rep === 'function' ? rep(f, idx, s) : rep);
        i = idx + f.length;
      }
      return out + s.slice(i);
    };
  }
  if (!Array.prototype.at) {
    Array.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      return n < 0 ? this[this.length + n] : this[n];
    };
  }
  if (!String.prototype.at) {
    String.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      return n < 0 ? this[this.length + n] : this[n];
    };
  }
  if (!Object.hasOwn) {
    Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  }
  if (!Array.prototype.findLast) {
    Array.prototype.findLast = function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
      return undefined;
    };
  }
  if (!Array.prototype.flat) {
    Array.prototype.flat = function (depth) {
      depth = depth === undefined ? 1 : Math.trunc(depth);
      return depth < 1 ? Array.prototype.slice.call(this)
        : Array.prototype.reduce.call(this, function (acc, cur) {
            return acc.concat(Array.isArray(cur) ? Array.prototype.flat.call(cur, depth - 1) : cur);
          }, []);
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, thisArg) {
      return Array.prototype.flat.call(Array.prototype.map.call(this, fn, thisArg));
    };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (entries) {
      var o = {};
      for (var it = entries[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) o[r.value[0]] = r.value[1];
      return o;
    };
  }
  if (!window.structuredClone) {
    window.structuredClone = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  }
})();
