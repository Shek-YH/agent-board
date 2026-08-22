# -*- coding: utf-8 -*-
# 豆包会话提取器（v2）
# 数据源：%LocalAppData%\Doubao\User Data\Default\IndexedDB\chrome_doubao-chat_0.indexeddb.leveldb\*.log
# 豆包 Electron IndexedDB (LevelDB) 字段结构（实测）：
#   "conversation_id"\x11<17位数字>"\x08bot_typeI\x00\x04name<varint><value>"\x0bpinned_time...
# - 字段名是 ASCII 字符串，前后用 " 包裹，varint 长度字节在引号后
# - name 值可能是 UTF-8 / 二进制 id 而非中文；放弃解析 name，直接用 user_texts[0] 当 title
# - 用户中文输入是 UTF-16LE 编码（CJK BMP 范围 0x4E00-0x9FFF）
# 关联策略：每个中文 token 找最近的 conversation_id 位置归属
import re, os, json, time

DB_DIR = os.path.join(os.environ.get('LOCALAPPDATA', r'C:\Users\Administrator\AppData\Local'),
                      'Doubao', 'User Data', 'Default', 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb')

COMMON = '的了一是我在你有和就天气查询今天明天北京广州周请帮我做个给说下吧吗你也可以不会那就'

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

def parse_conversations(data):
    """从 raw bytes 找 conversation_id 模式：
    字段名是裸字符串（前面有 varint 长度字节，无引号），ID 值是带引号的字符串（前面也有 varint 长度）。
    格式：...<varint:15>conversation_id<varint:17>"<17位数字>"...
    """
    sessions = {}
    pos_by_cid = {}
    for m in re.finditer(rb'conversation_id', data):
        # 跳过 'conversation_id' 后：varint 长度字节 + 引号 + 数字 + 引号
        # 紧跟 30 字节内找 " + varint-len + 引号 + 数字 + 引号
        seg = data[m.end():m.end() + 30]
        cand = re.search(rb'"[\x11-\x14]\d{14,20}"', seg)
        if not cand:
            continue
        cid = cand.group(0)[2:-1].decode('ascii')  # 去掉前 " + varint + 后 "
        pos_by_cid[cid] = m.start()
        if cid in sessions:
            # 同一 cid 多次出现：保留最后一次（最靠后 = 最新状态），位置取第一次
            sessions[cid]['_pos'] = m.start()
            continue
        # 抓 create/update_time（向后 1500 字节的 ASCII 视图；create_time/update_time 也是 varint+裸字段名）
        seg_text = data[m.end():m.end() + 1500].decode('utf-8', errors='ignore')
        ut = re.search(r'"update_time"[\x11-\x14]"?(\d{10,12})"?', seg_text)
        ct = re.search(r'"create_time"[\x11-\x14]"?(\d{10,12})"?', seg_text)
        ts = (int(ut.group(1)) if ut else (int(ct.group(1)) if ct else 0))
        sessions[cid] = {
            'id': cid,
            'ts': ts * 1000 if ts else 0,
            '_pos': m.start(),
            'user_texts': [],
        }
    return sessions, pos_by_cid

def parse_utf16le_tokens(data):
    """扫 UTF-16LE 连续中文 token（含常用字）"""
    out = []
    n = len(data) - 1
    i = 0
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
                if re.search(f'[{COMMON}]', s_tok):
                    t = clean(s_tok)
                    if 2 <= len(t) <= 60:
                        out.append((i, t))
            i = j
        else:
            i += 1
    return out

def extract():
    data = load_bin()
    sessions, pos_by_cid = parse_conversations(data)
    if not sessions:
        return []

    tokens = parse_utf16le_tokens(data)
    # 归属：每个 token 找最近的 conversation_id
    conv_pos = sorted([(p, cid) for cid, p in pos_by_cid.items()])
    for pos, t in tokens:
        best = None; best_d = 10**9
        for cpos, cid in conv_pos:
            d = abs(pos - cpos)
            if d < best_d and d < 800000:
                best_d = d; best = cid
        if best and best in sessions:
            s = sessions[best]
            if t not in s['user_texts'] and len(s['user_texts']) < 5:
                s['user_texts'].append(t)

    out = []
    # ts 处理：leveldb 没有真实时间戳，用 position 推算伪时间（最新 = now，最老 = 24h 前）
    base = int(time.time() * 1000)
    pos_vals = [s.get('_pos', 0) for s in sessions.values()]
    pos_min = min(pos_vals) if pos_vals else 0
    pos_max = max(pos_vals) if pos_vals else 1
    pos_span = max(pos_max - pos_min, 1)
    span_ms = 24 * 3600 * 1000  # 全部 session 散布在过去 24 小时
    for cid, s in sorted(sessions.items(), key=lambda x: -(x[1]['ts'] or x[1].get('_pos', 0))):
        title = s['user_texts'][0] if s['user_texts'] else '新对话'
        # 真实 ts > 1e12 才用，否则用 position 推算
        if s['ts'] > 1e12:
            ts = s['ts']
        else:
            rel = (s.get('_pos', 0) - pos_min) / pos_span  # 0~1
            ts = base - int(span_ms * (1 - rel))  # pos 越大越新
        out.append({
            'id': cid,
            'title': title[:50],
            'ts': ts,
            'user_texts': s['user_texts'][:5],
        })
    return out

if __name__ == '__main__':
    print(json.dumps(extract(), ensure_ascii=False, indent=1))
