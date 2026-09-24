// mdui 函数统一出口：import 'mdui' 注册全部 Web Components，函数从各子模块取。
import 'mdui';
import 'mdui/locales/zh-cn.js';
import { snackbar } from 'mdui/functions/snackbar.js';
import { dialog } from 'mdui/functions/dialog.js';
import { alert } from 'mdui/functions/alert.js';
import { confirm } from 'mdui/functions/confirm.js';
import { prompt } from 'mdui/functions/prompt.js';
import { setColorScheme } from 'mdui/functions/setColorScheme.js';
import { getColorFromImage } from 'mdui/functions/getColorFromImage.js';
import { setTheme } from 'mdui/functions/setTheme.js';
import { setLocale } from 'mdui/functions/setLocale.js';

try { setLocale('zh-CN'); } catch { /* locale 包缺失时静默 */ }

export const mdui = { snackbar, dialog, alert, confirm, prompt, setColorScheme, setTheme, getColorFromImage };
