// CSS は副作用 import (バンドラが取り込む)。tsc 向けに型だけ宣言しておく。
// 以前は vite/client の型がこれを提供していた。
declare module '*.css' {}
