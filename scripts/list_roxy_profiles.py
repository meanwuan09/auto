"""List RoxyBrowser workspaces and profiles without printing credentials."""

import sys
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "third_party/luno-automation/backend"))

from roxy_browser import _request


for page_index in range(1, 11):
    workspaces = _request("/browser/workspace?" + urlencode({"page_index": page_index, "page_size": 100}))
    rows = workspaces.get("rows", []) if isinstance(workspaces, dict) else []
    for workspace in rows:
        workspace_id = str(workspace["id"])
        print("WORKSPACE", workspace_id, workspace.get("workspaceName", ""))
        for profile_page in range(1, 11):
            profiles = _request("/browser/list_v3?" + urlencode({
                "workspaceId": workspace_id, "page_index": profile_page, "page_size": 100
            }))
            profile_rows = profiles.get("rows", []) if isinstance(profiles, dict) else []
            for profile in profile_rows:
                print("PROFILE", workspace_id, profile.get("dirId"), profile.get("windowSortNum"), profile.get("windowName"))
            if len(profile_rows) < 100:
                break
    if len(rows) < 100:
        break
