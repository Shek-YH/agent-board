# -*- coding: utf-8 -*-
# 豆包会话提取器（宽松版）
# 数据源：%LocalAppData%\Doubao\User Data\Default\IndexedDB\chrome_doubao-chat_0.indexeddb.leveldb\*.log
# 豆包是 Electron 应用，会话存 IndexedDB (LevelDB)，V8 序列化 + UTF-16LE 文本混排。
# 格式要点（实测）：
#   - conversation_id / create_time / update_time 以 UTF-16LE JSON 形式存在（字段名前面有二进制头乱码）
#   - 用户指令文本（如"北京一周天气查询"）出现在 content 字段
#   - 会话默认标题为"新对话"，无自定义标题 → 用首条用户指令当标题
# 本提取器用宽松正则抓取会话骨架（id + 时间 + 首条用户指令），够 agent board 展示 session 卡。
import re, os, json

DB_DIR = os.path.join(os.environ.get('LOCALAPPDATA', r'C:\Users\Administrator\AppData\Local'),
                      'Doubao', 'User Data', 'Default', 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb')

def load_bin():
    logs = []
    if os.path.isdir(DB_DIR):
        for f in sorted(os.listdir(DB_DIR)):
            if f.endswith('.log'):
                try: logs.append(open(os.path.join(DB_DIR, f), 'rb').read())
                except: pass
    return b''.join(logs)

def clean(s):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', s or '').strip()

def extract():
    data = load_bin()
    t16 = data.decode('utf-16-le', errors='ignore')
    sessions = {}
    # 1) 会话骨架：conversation_id + create/update_time（UTF-16LE 明文 JSON，时间在 ID 后 ~1000 字符内）
    for m in re.finditer(r'"conversation_id":"(\d+)"', t16):
        cid = m.group(1)
        seg = t16[m.end():m.end() + 1500]
        ct = re.search(r'"create_time":(\d+)', seg)
        ut = re.search(r'"update_time":(\d+)', seg)
        if cid not in sessions:
            sessions[cid] = {
                'id': cid,
                'ts': (int(ut.group(1)) if ut else (int(ct.group(1)) if ct else 0)) * 1000,
                'user_texts': [],
                'order': len(sessions),
            }
    # 2) 用户指令文本：字节流扫描 UTF-16LE 中文 token。
    #    伪中文（ASCII 字段名拼接，如 'chat_' -> 挀栀愀琀开）码位在 0x6000-0x7E7E 且不含常用字；
    #    真中文 token 含高频汉字（的/一/天/查询/天气/北京 等）→ 用常用字过滤即可可靠区分。
    conv_pos = [(m.start(), m.group(1)) for m in re.finditer(r'"conversation_id":"(\d+)"', t16)]
    text_items = []
    i = 0
    n = len(data) - 1
    while i < n:
        cp = data[i] | (data[i+1] << 8)
        if 0x4E00 <= cp <= 0x9FFF:
            j = i
            chars = []
            while j < n - 1:
                cp2 = data[j] | (data[j+1] << 8)
                if not (0x4E00 <= cp2 <= 0x9FFF): break
                chars.append(cp2)
                j += 2
            if len(chars) >= 2:
                s_tok = ''.join(chr(c) for c in chars)
                # 常用字过滤：真中文句子/指令几乎必含这些高频字；ASCII 拼凑不会
                if re.search(r'[的了一是我在你有和就天气查询今天明天北京广州周请帮我做个给]', s_tok):
                    t = s_tok.strip()
                    if 2 <= len(t) <= 60:
                        text_items.append((i, t))
            i = j
        else:
            i += 1
    # 归属：双向最近会话
    for pos, t in sorted(text_items):
        best = None; best_d = 10**9
        for cpos, cid in conv_pos:
            d = abs(pos - cpos)
            if d < best_d and d < 300000:
                best_d = d; best = cid
        if best and best in sessions:
            s = sessions[best]
            if t not in s['user_texts'] and len(s['user_texts']) < 10:
                s['user_texts'].append((pos, t))
    for s in sessions.values():
        s['user_texts'] = [t for _, t in sorted(s['user_texts'])]
    # 输出
    out = []
    for cid, s in sorted(sessions.items(), key=lambda x: x[1]['order']):
        # 标题 = 首条用户指令（豆包标题通常就是它）
        title = s['user_texts'][0] if s['user_texts'] else f'豆包会话 {cid[-6:]}'
        out.append({
            'id': cid,
            'title': title,
            'ts': s['ts'],
            'user_texts': s['user_texts'],
        })
    return out

if __name__ == '__main__':
    print(json.dumps(extract(), ensure_ascii=False, indent=1))
