from __future__ import annotations

from pathlib import Path

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger


def run_scheduler(pipeline):
    lock = Path("data/scheduler.lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    if lock.exists():
        raise RuntimeError("scheduler lock exists; another scheduler may be active")
    lock.write_text(str(__import__("os").getpid()), encoding="ascii")
    scheduler = BlockingScheduler(timezone=pipeline.settings.timezone)
    scheduler.add_job(pipeline.generate, CronTrigger(hour=9, minute=0),
                      id="daily-pipeline", max_instances=1, coalesce=True,
                      misfire_grace_time=3600, replace_existing=True)
    try:
        scheduler.start()
    finally:
        lock.unlink(missing_ok=True)
