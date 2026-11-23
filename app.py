#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ЦехУчёт — серверный прототип учёта задач цеха.
FastAPI + SQLite. Демо-данные создаются при первом запуске.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Iterator, Optional

from fastapi import Body, Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "ceh.db"
STATIC_DIR = BASE_DIR / "static"

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = bool(DATABASE_URL)
DEMO_MODE = os.environ.get("DEMO_MODE", "1").strip().lower() not in ("0", "false", "no", "off")
ACCESS_USER = os.environ.get("ACCESS_USER", "").strip()
ACCESS_PASSWORD = os.environ.get("ACCESS_PASSWORD", "").strip()
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").strip().lower()


def _read_seed_pins() -> dict[str, str]:
    raw = os.environ.get("SEED_PINS", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v).strip() for k, v in data.items() if str(v).strip()}


SEED_PINS = _read_seed_pins()

RATE_BYN = 25.0
VERSION = "2.1-cloud"

STATUS_LABELS = {
    "planned": "Запланирована",
    "in_progress": "В работе",
    "blocked": "Нужна помощь",
    "done": "Готово",
}

MACHINE_STATUS_LABELS = {
    "working": "Работает",
    "setup": "Наладка",
    "free": "Свободен",
    "repair": "Ремонт",
}

MOVE_REASONS = {
    "breakdown": "Поломка / ремонт",
    "no_tooling": "Нет оснастки",
    "overload": "Перегрузка станка",
    "priority": "Срочная задача",
    "quality": "Контроль / брак",
    "other": "Другая причина",
}

ROLE_LABELS = {"director": "Директор", "master": "Мастер", "worker": "Рабочий"}


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def now_local() -> datetime:
    return datetime.now().astimezone()


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def now_iso() -> str:
    return iso(now_local())


class HybridRow(dict):
    """Строка, к которой можно обращаться и по имени, и по номеру поля."""

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _pg_row_factory(cursor: Any) -> Any:
    names = [column.name for column in (cursor.description or [])]

    def make_row(values: Any) -> HybridRow:
        return HybridRow(zip(names, values))

    return make_row


class PgCursor:
    def __init__(self, cursor: Any, lastrowid: Optional[int] = None) -> None:
        self._cursor = cursor
        self._lastrowid = lastrowid

    @property
    def lastrowid(self) -> Optional[int]:
        return self._lastrowid

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()

    def __iter__(self) -> Any:
        return iter(self._cursor)


class PgConnection:
    """Небольшой слой совместимости: приложение написано под SQLite-синтаксис."""

    def __init__(self, raw: Any) -> None:
        self.raw = raw

    def execute(self, sql: str, params: Any = ()) -> PgCursor:
        pg_sql = sql.replace("?", "%s")
        lastrowid = None
        wants_id = pg_sql.lstrip().upper().startswith("INSERT INTO MOVEMENTS") and "RETURNING" not in pg_sql.upper()
        if wants_id:
            pg_sql = pg_sql.rstrip().rstrip(";") + " RETURNING id"
        cursor = self.raw.execute(pg_sql, params)
        if wants_id:
            row = cursor.fetchone()
            lastrowid = int(row["id"]) if row else None
        return PgCursor(cursor, lastrowid)

    def executemany(self, sql: str, rows: Any) -> None:
        with self.raw.cursor() as cursor:
            cursor.executemany(sql.replace("?", "%s"), rows)

    def executescript(self, script: str) -> None:
        for statement in script.split(";"):
            statement = statement.strip()
            if not statement:
                continue
            statement = statement.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
            self.raw.execute(statement)

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()

    def close(self) -> None:
        self.raw.close()


@contextmanager
def db() -> Iterator[Any]:
    if IS_POSTGRES:
        import psycopg

        conn = psycopg.connect(
            DATABASE_URL, row_factory=_pg_row_factory, connect_timeout=15,
            prepare_threshold=None, application_name="ceh-uchet",
        )
        wrapped = PgConnection(conn)
        try:
            yield wrapped
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return

    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('director','master','worker')),
    position TEXT NOT NULL,
    short TEXT NOT NULL,
    color TEXT NOT NULL,
    pin TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    group_name TEXT NOT NULL,
    spec TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'free',
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'part',
    title TEXT NOT NULL,
    article TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 0,
    done_qty INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'шт',
    norm_min REAL NOT NULL DEFAULT 0,
    fixed_hours REAL NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'planned',
    due_label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    machine_id TEXT NOT NULL REFERENCES machines(id),
    worker_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    from_machine_id TEXT REFERENCES machines(id),
    to_machine_id TEXT NOT NULL REFERENCES machines(id),
    moved_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_machine ON tasks(machine_id);
CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker_id);
CREATE INDEX IF NOT EXISTS idx_movements_task ON movements(task_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);
"""


USERS = [
    # id, name, role, position, short, color, pin, sort
    ("u1", "Андрей Соколов", "director", "Директор", "АС", "#1D4ED8", "1111", 1),
    ("u2", "Сергей Ковалёв", "master", "Мастер смены", "СК", "#B45309", "2222", 2),
    ("w1", "Игорь Петров", "worker", "Токарь", "ИП", "#1D4ED8", "3101", 10),
    ("w2", "Алексей Смирнов", "worker", "Фрезеровщик", "АС", "#0F766E", "3102", 11),
    ("w3", "Дмитрий Волков", "worker", "Шлифовщик", "ДВ", "#7C3AED", "3103", 12),
    ("w4", "Николай Егоров", "worker", "Слесарь-сборщик", "НЕ", "#BE123C", "3104", 13),
    ("w5", "Павел Морозов", "worker", "Оператор ЧПУ", "ПМ", "#0369A1", "3105", 14),
    ("w6", "Анна Крылова", "worker", "Контролёр ОТК", "АК", "#A21CAF", "3106", 15),
    ("w7", "Виктор Лебедев", "worker", "Наладчик", "ВЛ", "#475569", "3107", 16),
    ("w8", "Роман Зайцев", "worker", "Токарь", "РЗ", "#C2410C", "3108", 17),
    ("w9", "Тимур Хайруллин", "worker", "Фрезеровщик", "ТХ", "#334155", "3109", 18),
    ("w10", "Максим Орлов", "worker", "Слесарь", "МО", "#4D7C0F", "3110", 19),
    ("w11", "Елена Гусева", "worker", "Кладовщик", "ЕГ", "#0E7490", "3111", 20),
    ("w12", "Артём Фомин", "worker", "Ученик токаря", "АФ", "#6D28D9", "3112", 21),
]

MACHINES = [
    ("m1", "Фрезерный ЧПУ №1", "VMC650", "mill", "Стол 800×400 · 8 000 об/мин", "working", 1),
    ("m2", "Фрезерный ЧПУ №2", "VMC850", "mill", "Стол 1000×500 · 10 000 об/мин", "working", 2),
    ("m3", "Токарный ЧПУ №1", "ST-20", "turn", "Ø40 × 300 · 4 000 об/мин", "working", 3),
    ("m4", "Токарный ЧПУ №2", "QT-200", "turn", "Ø60 × 500 · 3 500 об/мин", "setup", 4),
    ("m5", "Токарный ЧПУ №3", "LT-300", "turn", "Ø120 × 700 · 2 500 об/мин", "working", 5),
    ("m6", "Эрозия проволочная", "Robocut α-C", "edm", "350×250×120 · проволока 0,2 мм", "working", 6),
    ("b1", "Слесарный пост", "Пост №1", "bench", "Зачистка · сверловка · резьба · упаковка", "free", 7),
    ("m7", "Токарный 16К20", "16К20", "turn", "Ø50 × 700 · ручной", "repair", 8),
]

# kind, title, article, qty, done, norm_min, fixed_h, priority, status, due, note, machine, worker, minutes_ago, sort
TASKS = [
    ("t1", "part", "Втулка-04", "D-1042", 60, 42, 10, 0, 1, "in_progress", "К 16:00",
     "Партия для сборки редуктора.", "m3", "w1", 370, 1),
    ("t2", "part", "Фланец-17", "D-2017", 30, 30, 18, 0, 1, "done", "К 15:00",
     "", "m1", "w2", 355, 2),
    ("t3", "part", "Корпус-10", "D-4410", 160, 58, 57, 0, 2, "in_progress", "Долгая",
     "Литьё. 45 мин машинного времени + 12 мин на замену. Партия идёт несколько смен.", "m2", "w8", 1320, 3),
    ("t4", "part", "Вал-05", "D-3305", 12, 0, 24, 0, 1, "blocked", "К 17:00",
     "Нет заготовок Ø40. Нужна помощь мастера.", "m4", "w1", 300, 4),
    ("t5", "part", "Вал-05", "D-3305", 15, 14, 24, 0, 1, "blocked", "К 15:30",
     "Привод станка не выходит на рабочие обороты.", "m5", "w3", 330, 5),
    ("t6", "part", "Шайба-07", "D-6007", 120, 45, 4, 0, 2, "in_progress", "К 18:00",
     "", "m3", "w5", 260, 6),
    ("t7", "part", "Кронштейн-20", "D-5120", 40, 0, 12, 0, 2, "planned", "После Фланца",
     "", "m1", "w2", 240, 7),
    ("t8", "part", "Пластина-Э", "D-7104", 8, 3, 90, 0, 1, "in_progress", "К 18:00",
     "Точный контур, проверить первую деталь у ОТК.", "m6", "w9", 280, 8),
    ("t9", "part", "Зачистка Втулки-04", "D-1042", 60, 0, 6, 0, 2, "planned", "После токарки",
     "Снять заусенцы и упаковать.", "b1", "w4", 210, 9),
    ("t10", "general", "Уборка станка 16К20", "", 0, 0, 0, 0.5, 3, "planned", "После смены",
     "Очистить рабочую зону, слить стружку.", "m7", "w10", 190, 10),
    ("t11", "general", "Наладка VMC650", "", 0, 0, 0, 1.0, 2, "planned", "К 12:00",
     "Подготовить оснастку под Кронштейн-20.", "m1", "w7", 180, 11),
    ("t12", "part", "Шайба-07", "D-6007", 200, 0, 4, 0, 3, "planned", "К 19:00",
     "", "m4", "w12", 150, 12),
]

SUBTASKS = {
    "t1": [("Изготовить детали", 0), ("Снять заусенцы", 1), ("Отпескоструить", 0), ("Упаковать", 0)],
    "t9": [("Снять заусенцы", 0), ("Проверить размеры", 0), ("Упаковать", 0)],
    "t10": [("Очистить рабочую зону", 0), ("Слить стружку", 0), ("Протереть направляющие", 0)],
    "t11": [("Проверить патрон", 0), ("Выставить нули", 0), ("Пробная деталь", 0)],
}


def upsert(conn: Any, table: str, columns: list[str], rows: Any, conflict: str = "id") -> None:
    placeholders = ",".join("?" for _ in columns)
    if IS_POSTGRES:
        updates = ", ".join(f"{col}=EXCLUDED.{col}" for col in columns if col != conflict)
        sql = (
            f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders}) "
            f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
        )
    else:
        sql = f"INSERT OR REPLACE INTO {table}({','.join(columns)}) VALUES({placeholders})"
    conn.executemany(sql, rows)


def seed(conn: Any, clear: bool = False) -> None:
    if clear:
        for table in ("sessions", "movements", "subtasks", "tasks", "machines", "users"):
            conn.execute(f"DELETE FROM {table}")

    users = []
    for item in USERS:
        row = list(item)
        if row[0] in SEED_PINS:
            row[6] = SEED_PINS[row[0]]
        users.append(tuple(row))

    upsert(conn, "users", ["id", "name", "role", "position", "short", "color", "pin", "active", "sort"],
           [(u[0], u[1], u[2], u[3], u[4], u[5], u[6], 1, u[7]) for u in users])
    upsert(conn, "machines", ["id", "name", "model", "group_name", "spec", "status", "sort"], MACHINES)

    now = now_local()
    initial_machine = {"t3": "m1", "t4": "m3", "t6": "m4"}
    for (tid, kind, title, article, qty, done, norm, fixed, priority, status, due, note,
         machine, worker, minutes_ago, sort) in TASKS:
        created = now - timedelta(minutes=minutes_ago)
        upsert(
            conn,
            "tasks",
            ["id", "kind", "title", "article", "qty", "done_qty", "unit", "norm_min", "fixed_hours",
             "priority", "status", "due_label", "note", "machine_id", "worker_id", "created_at",
             "updated_at", "sort"],
            [(tid, kind, title, article, qty, done, "шт" if kind == "part" else "", norm, fixed,
              priority, status, due, note, machine, worker, iso(created), iso(created), sort)],
        )
        conn.execute(
            "INSERT INTO movements(task_id,from_machine_id,to_machine_id,moved_by,reason,comment,created_at)"
            " VALUES(?,NULL,?,?,?,?,?)",
            (tid, initial_machine.get(tid, machine), worker if kind == "part" else "u2", "other", "Задача создана", iso(created)),
        )
        for idx, (st_title, st_done) in enumerate(SUBTASKS.get(tid, [])):
            upsert(conn, "subtasks", ["id", "task_id", "title", "done", "sort"],
                   [(f"{tid}-s{idx}", tid, st_title, st_done, idx)])

    # Несколько перемещений в истории, чтобы журнал был показательным.
    history = [
        ("t3", "m1", "m2", "u2", "overload", "Фланец-17 занял VMC650, Корпус перенесли на VMC850.", now - timedelta(hours=20, minutes=25)),
        ("t4", "m3", "m4", "u2", "no_tooling", "Патрон Ø40 занят, поставили на QT-200.", now - timedelta(hours=3, minutes=10)),
        ("t6", "m4", "m3", "u2", "priority", "Срочная партия шайб, перевели на свободный ST-20.", now - timedelta(hours=2, minutes=5)),
    ]
    for tid, src, dst, by, reason, comment, created in history:
        conn.execute(
            "INSERT INTO movements(task_id,from_machine_id,to_machine_id,moved_by,reason,comment,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (tid, src, dst, by, reason, comment, iso(created)),
        )

    # Чистим просроченные сессии.
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso(),))


def reset_database() -> None:
    with db() as conn:
        seed(conn, clear=True)


def init_db() -> None:
    if not IS_POSTGRES:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            seed(conn)


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


def user_public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "role_label": ROLE_LABELS.get(row["role"], row["role"]),
        "position": row["position"],
        "short": row["short"],
        "color": row["color"],
        "is_manager": row["role"] in ("director", "master"),
    }


def machine_public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "model": row["model"],
        "group": row["group_name"],
        "spec": row["spec"],
        "status": row["status"],
        "status_label": MACHINE_STATUS_LABELS.get(row["status"], row["status"]),
    }


def task_public(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    machine = conn.execute("SELECT * FROM machines WHERE id=?", (row["machine_id"],)).fetchone()
    worker = conn.execute("SELECT * FROM users WHERE id=?", (row["worker_id"],)).fetchone()
    subtasks = conn.execute("SELECT * FROM subtasks WHERE task_id=? ORDER BY sort, id", (row["id"],)).fetchall()
    moves = conn.execute("SELECT COUNT(*) FROM movements WHERE task_id=?", (row["id"],)).fetchone()[0]

    if row["kind"] == "general":
        norm_hours = float(row["fixed_hours"] or 0)
        earned = norm_hours * RATE_BYN if row["status"] == "done" else 0.0
        progress = 1.0 if row["status"] == "done" else 0.0
    else:
        qty = max(int(row["qty"] or 0), 1)
        norm_hours = qty * float(row["norm_min"] or 0) / 60.0
        earned = int(row["done_qty"]) * float(row["norm_min"] or 0) / 60.0 * RATE_BYN
        progress = min(max(int(row["done_qty"]) / qty, 0.0), 1.0)

    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "article": row["article"],
        "qty": row["qty"],
        "done_qty": row["done_qty"],
        "unit": row["unit"],
        "norm_min": row["norm_min"],
        "fixed_hours": row["fixed_hours"],
        "norm_hours": round(norm_hours, 2),
        "earned_byn": round(earned, 2),
        "progress": round(progress, 4),
        "priority": row["priority"],
        "status": row["status"],
        "status_label": STATUS_LABELS.get(row["status"], row["status"]),
        "due_label": row["due_label"],
        "note": row["note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "machine": machine_public(machine) if machine else None,
        "worker": user_public(worker) if worker else None,
        "subtasks": [
            {"id": s["id"], "title": s["title"], "done": bool(s["done"])} for s in subtasks
        ],
        "movements_count": moves,
    }


def movement_public(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    task = conn.execute("SELECT id,title,article FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
    src = conn.execute("SELECT * FROM machines WHERE id=?", (row["from_machine_id"],)).fetchone() if row["from_machine_id"] else None
    dst = conn.execute("SELECT * FROM machines WHERE id=?", (row["to_machine_id"],)).fetchone()
    by = conn.execute("SELECT * FROM users WHERE id=?", (row["moved_by"],)).fetchone()
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "task_title": task["title"] if task else "",
        "task_article": task["article"] if task else "",
        "from_machine": machine_public(src) if src else None,
        "to_machine": machine_public(dst) if dst else None,
        "moved_by": user_public(by) if by else None,
        "reason": row["reason"],
        "reason_label": MOVE_REASONS.get(row["reason"], "Другая причина" if row["reason"] == "new" else row["reason"]),
        "comment": row["comment"],
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def get_current_user(request: Request) -> dict[str, Any]:
    token = request.cookies.get("ceh_session")
    if not token:
        raise HTTPException(status_code=401, detail="Нужно войти в систему")
    with db() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token=? AND s.expires_at>? AND u.active=1",
            (token, now_iso()),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Сессия истекла. Войдите снова")
    return user_public(row)


def require_manager(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if not user["is_manager"]:
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    return user


def can_edit_task(conn: sqlite3.Connection, user: dict[str, Any], task_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if not user["is_manager"] and row["worker_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Можно менять только свои задачи")
    return row


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class LoginIn(BaseModel):
    pin: str = Field(min_length=4, max_length=8)


class MoveIn(BaseModel):
    to_machine_id: str
    reason: str
    comment: str = Field(default="", max_length=500)


class ProgressIn(BaseModel):
    done_qty: int = Field(ge=0, le=1000000)


class StatusIn(BaseModel):
    status: str


class TaskPatchIn(BaseModel):
    priority: Optional[int] = Field(default=None, ge=1, le=3)
    worker_id: Optional[str] = None
    due_label: Optional[str] = Field(default=None, max_length=40)
    note: Optional[str] = Field(default=None, max_length=1000)


class TaskCreateIn(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    article: str = Field(default="", max_length=40)
    qty: int = Field(ge=1, le=100000)
    norm_min: float = Field(gt=0, le=10000)
    machine_id: str
    worker_id: str
    priority: int = Field(default=2, ge=1, le=3)
    due_label: str = Field(default="К концу смены", max_length=40)
    note: str = Field(default="", max_length=1000)


class MachinePatchIn(BaseModel):
    status: str


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="ЦехУчёт API", version=VERSION, docs_url="/api/docs", redoc_url=None)


# Необязательная общая защита паролем: браузер спросит логин и пароль один раз.
@app.middleware("http")
async def access_gate(request: Request, call_next: Any) -> Any:
    if not ACCESS_PASSWORD or request.url.path in ("/api/health", "/api/ping"):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    ok = False
    if header.lower().startswith("basic "):
        try:
            decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
            username, password = decoded.split(":", 1)
            ok = secrets.compare_digest(username, ACCESS_USER or "ceh") and secrets.compare_digest(password, ACCESS_PASSWORD)
        except Exception:
            ok = False
    if not ok:
        return Response(
            status_code=401,
            content="Требуется пароль доступа",
            headers={"WWW-Authenticate": 'Basic realm="CehUchet", charset="UTF-8"'},
        )
    return await call_next(request)


_login_fails: dict[str, deque[float]] = defaultdict(deque)
_login_lock = Lock()
LOGIN_WINDOW = 600
LOGIN_MAX_PER_IP = 20
LOGIN_MAX_PER_PIN = 5


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def _prune_attempts(queue: deque[float], now: float) -> None:
    while queue and now - queue[0] > LOGIN_WINDOW:
        queue.popleft()


def check_login_allowed(ip: str, pin: str) -> None:
    now = time.monotonic()
    with _login_lock:
        ip_queue = _login_fails[f"ip:{ip}"]
        pin_queue = _login_fails[f"pin:{ip}:{pin}"]
        _prune_attempts(ip_queue, now)
        _prune_attempts(pin_queue, now)
        if len(ip_queue) >= LOGIN_MAX_PER_IP or len(pin_queue) >= LOGIN_MAX_PER_PIN:
            raise HTTPException(status_code=429, detail="Слишком много попыток входа. Подождите 10 минут")


def record_login_failure(ip: str, pin: str) -> None:
    now = time.monotonic()
    with _login_lock:
        _login_fails[f"ip:{ip}"].append(now)
        _login_fails[f"pin:{ip}:{pin}"].append(now)


def _secure_cookie(request: Request) -> bool:
    if COOKIE_SECURE in ("1", "true", "yes", "on"):
        return True
    if COOKIE_SECURE in ("0", "false", "no", "off"):
        return False
    proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
    return request.url.scheme == "https" or proto == "https"


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/ping")
def ping() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        with db() as conn:
            conn.execute("SELECT 1").fetchone()
        return {
            "ok": True,
            "version": VERSION,
            "time": now_iso(),
            "db": "postgresql" if IS_POSTGRES else "sqlite",
        }
    except Exception as exc:  # pragma: no cover
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})


@app.get("/api/config")
def public_config() -> dict[str, Any]:
    return {"demo_mode": DEMO_MODE, "version": VERSION, "db": "postgresql" if IS_POSTGRES else "sqlite"}


@app.get("/api/demo-accounts")
def demo_accounts() -> list[dict[str, Any]]:
    if not DEMO_MODE:
        return []
    ids = ("u1", "u2", "w1", "w8")
    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM users WHERE id IN ({','.join('?' for _ in ids)}) ORDER BY sort", ids
        ).fetchall()
    return [
        {**user_public(r), "pin": r["pin"], "hint": "Директор и мастер видят всё" if r["role"] != "worker" else "Свои задачи и перемещения"}
        for r in rows
    ]


@app.post("/api/auth/login")
def login(payload: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    pin = payload.pin.strip()
    ip = _client_ip(request)
    check_login_allowed(ip, pin)
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE pin=? AND active=1", (pin,)).fetchone()
        if not row:
            record_login_failure(ip, pin)
            raise HTTPException(status_code=401, detail="Неверный PIN")
        token = secrets.token_urlsafe(32)
        expires = now_local() + timedelta(days=7)
        conn.execute(
            "INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)",
            (token, row["id"], now_iso(), iso(expires)),
        )
    response.set_cookie(
        "ceh_session", token, max_age=7 * 24 * 3600, httponly=True, samesite="lax",
        secure=_secure_cookie(request), path="/",
    )
    return user_public(row)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get("ceh_session")
    if token:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
    response.delete_cookie("ceh_session", path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    return user


@app.get("/api/bootstrap")
def bootstrap(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with db() as conn:
        machines = conn.execute("SELECT * FROM machines ORDER BY sort").fetchall()
        users = conn.execute("SELECT * FROM users WHERE active=1 ORDER BY sort").fetchall()
        tasks = conn.execute("SELECT * FROM tasks ORDER BY sort, created_at").fetchall()
        movements = conn.execute("SELECT * FROM movements ORDER BY created_at DESC, id DESC LIMIT 120").fetchall()
        if not user["is_manager"]:
            tasks = [t for t in tasks if t["worker_id"] == user["id"]]
            own_ids = {t["id"] for t in tasks}
            movements = [m for m in movements if m["task_id"] in own_ids]
        return {
            "user": user,
            "rate_byn": RATE_BYN,
            "version": VERSION,
            "server_time": now_iso(),
            "machines": [machine_public(m) for m in machines],
            "staff": [user_public(u) for u in users],
            "tasks": [task_public(conn, t) for t in tasks],
            "movements": [movement_public(conn, m) for m in movements],
            "status_labels": STATUS_LABELS,
            "machine_status_labels": MACHINE_STATUS_LABELS,
            "move_reasons": [{"id": k, "label": v} for k, v in MOVE_REASONS.items()],
        }


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Задача не найдена")
        if not user["is_manager"] and row["worker_id"] != user["id"]:
            raise HTTPException(status_code=403, detail="Можно смотреть только свои задачи")
        return task_public(conn, row)


@app.post("/api/tasks")
def create_task(payload: TaskCreateIn, user: dict[str, Any] = Depends(require_manager)) -> dict[str, Any]:
    with db() as conn:
        machine = conn.execute("SELECT * FROM machines WHERE id=?", (payload.machine_id,)).fetchone()
        worker = conn.execute("SELECT * FROM users WHERE id=? AND role='worker'", (payload.worker_id,)).fetchone()
        if not machine:
            raise HTTPException(status_code=400, detail="Станок не найден")
        if not worker:
            raise HTTPException(status_code=400, detail="Исполнитель не найден")
        if machine["status"] == "repair":
            raise HTTPException(status_code=400, detail="Нельзя поставить задачу на станок в ремонте")
        task_id = "t" + secrets.token_hex(4)
        created = now_iso()
        sort = conn.execute("SELECT COALESCE(MAX(sort),0)+1 FROM tasks").fetchone()[0]
        conn.execute(
            """INSERT INTO tasks
               (id,kind,title,article,qty,done_qty,unit,norm_min,fixed_hours,priority,status,
                due_label,note,machine_id,worker_id,created_at,updated_at,sort)
               VALUES(?,?,?,?,?,0,'шт',?,0,?, 'planned',?,?,?,?,?,?,?)""",
            (task_id, "part", payload.title.strip(), payload.article.strip(), payload.qty,
             payload.norm_min, payload.priority, payload.due_label.strip(), payload.note.strip(),
             payload.machine_id, payload.worker_id, created, created, sort),
        )
        conn.execute(
            "INSERT INTO subtasks(id,task_id,title,done,sort) VALUES(?,?,?,0,0)",
            (task_id + "-s0", task_id, "Изготовить детали"),
        )
        conn.execute(
            "INSERT INTO movements(task_id,from_machine_id,to_machine_id,moved_by,reason,comment,created_at)"
            " VALUES(?,NULL,?,?,?,?,?)",
            (task_id, payload.machine_id, user["id"], "other", "Задача создана", created),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return task_public(conn, row)


@app.patch("/api/tasks/{task_id}")
def patch_task(task_id: str, payload: TaskPatchIn, user: dict[str, Any] = Depends(require_manager)) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Задача не найдена")
        fields, values = [], []
        if payload.priority is not None:
            fields.append("priority=?")
            values.append(payload.priority)
        if payload.worker_id is not None:
            worker = conn.execute("SELECT * FROM users WHERE id=? AND role='worker'", (payload.worker_id,)).fetchone()
            if not worker:
                raise HTTPException(status_code=400, detail="Исполнитель не найден")
            fields.append("worker_id=?")
            values.append(payload.worker_id)
        if payload.due_label is not None:
            fields.append("due_label=?")
            values.append(payload.due_label.strip())
        if payload.note is not None:
            fields.append("note=?")
            values.append(payload.note.strip())
        if not fields:
            return task_public(conn, row)
        fields.append("updated_at=?")
        values.append(now_iso())
        values.append(task_id)
        conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", values)
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return task_public(conn, row)


@app.post("/api/tasks/{task_id}/progress")
def set_progress(task_id: str, payload: ProgressIn, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with db() as conn:
        row = can_edit_task(conn, user, task_id)
        if row["kind"] != "part":
            raise HTTPException(status_code=400, detail="Для общей задачи используйте статус")
        done = min(max(payload.done_qty, 0), int(row["qty"]))
        if done >= int(row["qty"]):
            status = "done"
        elif row["status"] in ("planned", "blocked", "done"):
            status = "in_progress" if done > 0 else ("blocked" if row["status"] == "blocked" else "planned")
        else:
            status = "in_progress"
        conn.execute(
            "UPDATE tasks SET done_qty=?, status=?, updated_at=? WHERE id=?",
            (done, status, now_iso(), task_id),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return task_public(conn, row)


@app.post("/api/tasks/{task_id}/status")
def set_status(task_id: str, payload: StatusIn, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if payload.status not in STATUS_LABELS:
        raise HTTPException(status_code=400, detail="Неизвестный статус")
    with db() as conn:
        row = can_edit_task(conn, user, task_id)
        if not user["is_manager"] and payload.status not in ("in_progress", "blocked"):
            raise HTTPException(status_code=403, detail="Рабочий может взять задачу или сообщить о проблеме")
        done = int(row["done_qty"])
        if payload.status == "done":
            done = int(row["qty"]) if row["kind"] == "part" else done
        elif row["status"] == "done" and row["kind"] == "part" and done >= int(row["qty"]):
            done = max(int(row["qty"]) - 1, 0)
        conn.execute(
            "UPDATE tasks SET status=?, done_qty=?, updated_at=? WHERE id=?",
            (payload.status, done, now_iso(), task_id),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return task_public(conn, row)


@app.post("/api/tasks/{task_id}/subtasks/{subtask_id}")
def toggle_subtask(task_id: str, subtask_id: str, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    with db() as conn:
        can_edit_task(conn, user, task_id)
        sub = conn.execute("SELECT * FROM subtasks WHERE id=? AND task_id=?", (subtask_id, task_id)).fetchone()
        if not sub:
            raise HTTPException(status_code=404, detail="Подзадача не найдена")
        conn.execute("UPDATE subtasks SET done=? WHERE id=?", (0 if sub["done"] else 1, subtask_id))
        conn.execute("UPDATE tasks SET updated_at=? WHERE id=?", (now_iso(), task_id))
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return task_public(conn, row)


@app.post("/api/tasks/{task_id}/move")
def move_task(task_id: str, payload: MoveIn, user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    if payload.reason not in MOVE_REASONS:
        raise HTTPException(status_code=400, detail="Выберите причину перемещения")
    with db() as conn:
        row = can_edit_task(conn, user, task_id)
        if row["status"] == "done":
            raise HTTPException(status_code=400, detail="Задача уже закрыта")
        target = conn.execute("SELECT * FROM machines WHERE id=?", (payload.to_machine_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=400, detail="Станок не найден")
        if target["id"] == row["machine_id"]:
            raise HTTPException(status_code=400, detail="Задача уже на этом станке")
        if target["status"] == "repair":
            raise HTTPException(status_code=400, detail="Станок на ремонте — выберите другой")
        created = now_iso()
        cur = conn.execute(
            "INSERT INTO movements(task_id,from_machine_id,to_machine_id,moved_by,reason,comment,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (task_id, row["machine_id"], payload.to_machine_id, user["id"], payload.reason,
             payload.comment.strip(), created),
        )
        conn.execute(
            "UPDATE tasks SET machine_id=?, updated_at=? WHERE id=?",
            (payload.to_machine_id, created, task_id),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        movement = conn.execute("SELECT * FROM movements WHERE id=?", (cur.lastrowid,)).fetchone()
        return {"task": task_public(conn, row), "movement": movement_public(conn, movement)}


@app.get("/api/movements")
def list_movements(
    task_id: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    with db() as conn:
        if task_id:
            if not user["is_manager"]:
                own = conn.execute("SELECT 1 FROM tasks WHERE id=? AND worker_id=?", (task_id, user["id"])).fetchone()
                if not own:
                    raise HTTPException(status_code=403, detail="Можно смотреть только свои задачи")
            rows = conn.execute(
                "SELECT * FROM movements WHERE task_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
                (task_id, limit),
            ).fetchall()
        elif user["is_manager"]:
            rows = conn.execute(
                "SELECT * FROM movements ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM movements WHERE task_id IN (SELECT id FROM tasks WHERE worker_id=?)"
                " ORDER BY created_at DESC, id DESC LIMIT ?", (user["id"], limit),
            ).fetchall()
        return [movement_public(conn, r) for r in rows]


@app.get("/api/movements.csv")
def movements_csv(user: dict[str, Any] = Depends(require_manager)) -> StreamingResponse:
    with db() as conn:
        rows = conn.execute("SELECT * FROM movements ORDER BY created_at DESC, id DESC").fetchall()
        items = [movement_public(conn, r) for r in rows]
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["Дата и время", "Задача", "Артикул", "Откуда", "Куда", "Кто", "Причина", "Комментарий"])
    for m in items:
        writer.writerow([
            m["created_at"], m["task_title"], m["task_article"],
            m["from_machine"]["name"] if m["from_machine"] else "—",
            m["to_machine"]["name"] if m["to_machine"] else "—",
            m["moved_by"]["name"] if m["moved_by"] else "—",
            m["reason_label"], m["comment"],
        ])
    data = buf.getvalue().encode("utf-8")
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=peremeshcheniya.csv"},
    )


@app.patch("/api/machines/{machine_id}")
def patch_machine(machine_id: str, payload: MachinePatchIn, user: dict[str, Any] = Depends(require_manager)) -> dict[str, Any]:
    if payload.status not in MACHINE_STATUS_LABELS:
        raise HTTPException(status_code=400, detail="Неизвестный статус станка")
    with db() as conn:
        row = conn.execute("SELECT * FROM machines WHERE id=?", (machine_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Станок не найден")
        conn.execute("UPDATE machines SET status=? WHERE id=?", (payload.status, machine_id))
        row = conn.execute("SELECT * FROM machines WHERE id=?", (machine_id,)).fetchone()
        return machine_public(row)


@app.post("/api/admin/reset")
def reset_demo(response: Response, user: dict[str, Any] = Depends(require_manager)) -> dict[str, bool]:
    reset_database()
    response.delete_cookie("ceh_session", path="/")
    return {"ok": True}


@app.exception_handler(HTTPException)
def http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print("\n  ЦехУчёт запущен: http://%s:%s\n" % (host, port))
    uvicorn.run(app, host=host, port=port, reload=False)
