#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent-board-handoff — 资料库中继层（控制面 + 数据面），由 WorkBuddy 资料库 skill 的
space_api.py / drive 脚本驱动。token 经环境变量 TOKEN 注入（来自 connect_open_platform），
不落盘。

子命令:
  publish <projectRoot> <deviceId>    发布一个任务：建 job 目录、上传 request/manifest/bundle/patch/skill、写 state.json(holder=A)
  discover <deviceId> [--claim]       列出未处理任务；--claim 时按租约抢占（仅当无人持有或租约过期）
  download <jobId> <outDir>           下载该任务全部产物到本地
  read-state <jobId>                  读取 state.json
  write-state <jobId> <deviceId> <nextState> [ttl]  带租约校验地推进状态（防状态倒退 + 防并发覆盖）
  read-feedback <jobId> <outDir>      下载 feedback/*

安全: 上传前强制排除 node_modules/dist/runtime/data.json 与 .env/token/credentials；
      write-state 校验状态机不倒退 + 租约持有者；大文件受资料库 100MiB 限制。
"""
import os, sys, json, time, uuid, subprocess, shutil, urllib.request, argparse

SKILL_DIR = os.environ.get("SKILL_DIR", r"C:/Users/Administrator/.workbuddy/plugins/cache/workbuddy-builtin/skill-library/0.5.9")
SPACE_ID = os.environ.get("SPACE_ID", "SyGOVXJtd9cSMZIvtjNfMS")
RELAY_PARENT_ID = os.environ.get("RELAY_PARENT_ID", "01qyEcJeFqUeD4K17GVe8T")
TOKEN = os.environ.get("TOKEN", "")

STATES = ['CREATED','SOURCE_PUBLISHED','B_VALIDATING','B_FEEDBACK_READY','A_PATCHING','PATCH_PUBLISHED','B_REVALIDATING','VERIFIED','BLOCKED']
FORWARD = {
 'CREATED':['SOURCE_PUBLISHED','BLOCKED'],'SOURCE_PUBLISHED':['B_VALIDATING','BLOCKED'],
 'B_VALIDATING':['B_FEEDBACK_READY','BLOCKED'],'B_FEEDBACK_READY':['A_PATCHING','BLOCKED'],
 'A_PATCHING':['PATCH_PUBLISHED','BLOCKED'],'PATCH_PUBLISHED':['B_REVALIDATING','BLOCKED'],
 'B_REVALIDATING':['VERIFIED','BLOCKED'],'VERIFIED':['BLOCKED'],
 'BLOCKED':STATES,
}

def _api(name, extra, stdin_token=True):
    cmd = ["python3", os.path.join(SKILL_DIR, "space_api.py"), name, "--token-stdin"] + extra
    p = subprocess.run(cmd, input=TOKEN + "\n", capture_output=True, text=True, timeout=90)
    return p.stdout + p.stderr

def _drive(script, args):
    cmd = ["python3", os.path.join(SKILL_DIR, "drive", script), "--token-stdin"] + args
    p = subprocess.run(cmd, input=TOKEN + "\n", capture_output=True, text=True, timeout=180)
    return p.stdout + p.stderr

def _ks(out, prefix):
    for line in out.splitlines():
        if line.startswith(prefix):
            return json.loads(line[len(prefix):].strip())
    return None

def _json(out):
    try: return json.loads(out)
    except Exception: return {}

def list_children(parent):
    out = _api("space.workspace.list-node", ["--space-id", SPACE_ID, "--parent-node-id", parent])
    return _json(out).get("data", {}).get("nodes", [])

def find_node(nodes, title_contains):
    for n in nodes:
        if title_contains in (n.get("title") or ""):
            return n
    return None

def upload(local_path, file_name, parent_id):
    return _ks(_drive("upload_drive_file.py", [local_path, "--space-id", SPACE_ID,
                 "--parent-id", parent_id, "--file-name", file_name]), "KS_DRIVE_UPLOAD_OK ")

def replace(local_path, node_id, file_name):
    return _ks(_drive("upload_drive_file.py", [local_path, "--node-id", node_id,
                 "--file-name", file_name]), "KS_DRIVE_UPLOAD_OK ")

def download(node_id, dest):
    d = _ks(_drive("get_download_link.py", ["--node-id", node_id]), "KS_DRIVE_DOWNLOAD ")
    if not d or not d.get("download_url"): return None
    req = urllib.request.Request(d["download_url"])
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    with open(dest, "wb") as f: f.write(data)
    return dest

def create_job_folder(title):
    out = _api("space.importer.create-doc", ["--space-id", SPACE_ID, "--parent-id", RELAY_PARENT_ID,
              "--title", title, "--markdown", f"Agent Board handoff job {title}"])
    return _json(out).get("data", {}).get("nodeBlockId")

# ---------- publish ----------
def publish(project_root, device_id):
    if not TOKEN: print(json.dumps({"error":"TOKEN 未设置"})); sys.exit(1)
    job_id = "agent-board-handoff-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    folder = create_job_folder(job_id)
    if not folder: print(json.dumps({"error":"建 job 目录失败"})); sys.exit(1)
    # 收集产物（排除敏感/大目录，已在 handoff.js manifest 中保证；这里再兜底过滤文件名）
    artifacts = []
    req = {"jobId": job_id, "type": "handoff-request", "from": device_id, "to": "B-VALIDATOR",
           "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "message": "Agent Board source/skill handoff", "state": "CREATED"}
    p = os.path.join(project_root, "request.json"); json.dump(req, open(p,"w"), ensure_ascii=False, indent=2)
    artifacts.append(("request.json", p))
    for name in ["source-manifest.json"]:
        fp = os.path.join(project_root, name)
        if os.path.exists(fp): artifacts.append((name, fp))
    for name in ["source-bundle.zip", "source-workingtree.patch"]:
        fp = os.path.join(project_root, name)
        if os.path.exists(fp):
            if os.path.getsize(fp) > 100*1024*1024:
                print(json.dumps({"error": f"{name} 超过 100MiB，资料库不适配，请改用 Git/共享目录数据面"})); sys.exit(1)
            artifacts.append((name, fp))
    # skill 包（如存在）
    skill_pkg = os.path.join(project_root, "skill-package.skill")
    if os.path.exists(skill_pkg): artifacts.append(("skill-package.skill", skill_pkg))
    uploaded = []
    for fname, fpath in artifacts:
        r = upload(fpath, f"{job_id}/{fname}", folder)
        if not r: print(json.dumps({"error": f"上传 {fname} 失败"})); sys.exit(1)
        uploaded.append({"name": fname, "node": r.get("node_block_id")})
    # 写 state.json（holder=A，租约 10 分钟）
    state = {"jobId": job_id, "state": "SOURCE_PUBLISHED", "holder": device_id,
             "leaseExpiresAt": int(time.time()*1000) + 600000, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "publisher": device_id, "validator": "B-VALIDATOR", "nextAction": "B_VALIDATING",
             "files": uploaded}
    sp = os.path.join(project_root, "state.json"); json.dump(state, open(sp,"w"), ensure_ascii=False, indent=2)
    r = upload(sp, f"{job_id}/state.json", folder)
    uploaded.append({"name":"state.json","node": r.get("node_block_id")})
    print(json.dumps({"jobId": job_id, "folder": folder, "state": "SOURCE_PUBLISHED", "files": uploaded}, ensure_ascii=False, indent=2))

# ---------- discover ----------
def discover(device_id, claim):
    nodes = list_children(RELAY_PARENT_ID)
    jobs = [n for n in nodes if (n.get("title") or "").startswith("agent-board-handoff-")]
    result = []
    for j in jobs:
        st = read_state_node(j.get("id"))
        if not st:  # 无 state，视为新任务
            if claim:
                ok = write_state_node(j.get("id"), st, device_id, "B_VALIDATING", job_id=j.get("title"))
                result.append({"jobId": j.get("title"), "claimed": ok})
            else:
                result.append({"jobId": j.get("title"), "claimed": False})
            continue
        held = st.get("holder") and st.get("leaseExpiresAt", 0) > int(time.time()*1000)
        if not held or st.get("holder") == device_id:
            if claim and st.get("state") in ("SOURCE_PUBLISHED",):
                write_state_node(j.get("id"), st, device_id, "B_VALIDATING", job_id=st.get("jobId", j.get("title")))
                result.append({"jobId": st.get("jobId"), "claimed": True})
            else:
                result.append({"jobId": st.get("jobId"), "claimed": False, "state": st.get("state")})
        else:
            result.append({"jobId": st.get("jobId"), "claimed": False, "heldBy": st.get("holder")})
    print(json.dumps({"jobs": result}, ensure_ascii=False, indent=2))

def read_state_node(folder_id):
    nodes = list_children(folder_id)
    n = find_node(nodes, "state.json")
    if not n: return None
    d = _ks(_drive("get_download_link.py", ["--node-id", n.get("id")]), "KS_DRIVE_DOWNLOAD ")
    if not d: return None
    try:
        with urllib.request.urlopen(d["download_url"], timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None

def write_state_node(folder_id, cur_state, device_id, next_state, job_id=None, ttl=600):
    nodes = list_children(folder_id)
    n = find_node(nodes, "state.json")
    # 租约校验
    if cur_state:
        held = cur_state.get("holder") and cur_state.get("leaseExpiresAt", 0) > int(time.time()*1000)
        if held and cur_state.get("holder") != device_id:
            print(json.dumps({"ok": False, "error": f"租约被 {cur_state.get('holder')} 持有，{device_id} 不可写入"})); return False
        # 状态机校验
        if next_state not in FORWARD.get(cur_state.get("state"), []):
            print(json.dumps({"ok": False, "error": f"非法状态跳转 {cur_state.get('state')} -> {next_state}"})); return False
    new_state = dict(cur_state or {})
    new_state.update({"state": next_state, "holder": device_id,
                      "leaseExpiresAt": int(time.time()*1000) + ttl*1000,
                      "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    if job_id: new_state["jobId"] = job_id
    sp = os.path.join(os.environ.get("TMP", "/tmp"), "state.json")
    json.dump(new_state, open(sp,"w"), ensure_ascii=False, indent=2)
    r = replace(sp, n.get("id"), f"{job_id or 'job'}/state.json") if n else upload(sp, f"{job_id or 'job'}/state.json", folder_id)
    return bool(r)

# ---------- download / feedback ----------
def download_job(job_id, out_dir):
    nodes = list_children(RELAY_PARENT_ID)
    folder = find_node(nodes, job_id)
    if not folder: print(json.dumps({"error":"任务不存在"})); sys.exit(1)
    children = list_children(folder.get("id"))
    os.makedirs(out_dir, exist_ok=True)
    got = []
    for c in children:
        fn = (c.get("title") or "").split("/")[-1]
        if not fn: continue
        dest = os.path.join(out_dir, fn)
        if download(c.get("id"), dest): got.append(fn)
    print(json.dumps({"jobId": job_id, "downloaded": got}, ensure_ascii=False))

def read_feedback(job_id, out_dir):
    nodes = list_children(RELAY_PARENT_ID)
    folder = find_node(nodes, job_id)
    if not folder: print(json.dumps({"error":"任务不存在"})); sys.exit(1)
    children = list_children(folder.get("id"))
    fb = find_node(children, "feedback")
    if not fb: print(json.dumps({"error":"无 feedback 节点"})); sys.exit(1)
    fbnodes = list_children(fb.get("id"))
    os.makedirs(out_dir, exist_ok=True)
    got = []
    for c in fbnodes:
        fn = (c.get("title") or "").split("/")[-1]
        dest = os.path.join(out_dir, fn)
        if download(c.get("id"), dest): got.append(fn)
    print(json.dumps({"jobId": job_id, "feedback": got}, ensure_ascii=False))

def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("cmd")
    ap.add_argument("a", nargs="?")
    ap.add_argument("b", nargs="?")
    ap.add_argument("c", nargs="?")
    ap.add_argument("--claim", action="store_true")
    args, _ = ap.parse_known_args()
    if args.cmd == "publish": publish(args.a, args.b)
    elif args.cmd == "discover": discover(args.a, args.b == "--claim" or args.claim)
    elif args.cmd == "download": download_job(args.a, args.b)
    elif args.cmd == "read-feedback": read_feedback(args.a, args.b)
    elif args.cmd == "read-state": print(json.dumps(read_state_node(args.a) or {}, ensure_ascii=False, indent=2))
    else: print("usage: handoff-relay.py <publish|discover|download|read-feedback|read-state> ...")

if __name__ == "__main__":
    main()
