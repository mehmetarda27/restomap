#!/usr/bin/env python3
"""
RESTOMAP platform auto-feeder worker.

Polls active platform accounts, normalizes new orders, and feeds them into the
existing RESTOMAP integration API. The backend remains the source of truth for
package creation, validation, duplicate handling, assignment, audit logs, and
webhook logs.
"""

from __future__ import annotations

import base64
import dataclasses
import datetime as dt
import json
import logging
import os
import signal
import sqlite3
import sys
import time
from typing import Any

import requests


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB_FILE = os.path.join(ROOT_DIR, "delivera.sqlite")
DEFAULT_CACHE_FILE = os.path.join(ROOT_DIR, "processed_orders.db")
SUPPORTED_PLATFORMS = {
    "trendyol go": "Trendyol Go",
    "trendyol": "Trendyol Go",
    "getiryemek": "GetirYemek",
    "getir yemek": "GetirYemek",
    "getir": "GetirYemek",
    "yemeksepeti": "Yemeksepeti",
    "migros yemek": "Migros Yemek",
    "migros": "Migros Yemek",
}
PLATFORM_ENV_PREFIX = {
    "Trendyol Go": "TRENDYOL",
    "GetirYemek": "GETIR",
    "Yemeksepeti": "YEMEKSEPETI",
    "Migros Yemek": "MIGROS",
}


def load_dotenv(path: str) -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip().strip("\"'")


load_dotenv(os.path.join(ROOT_DIR, ".env"))


LOG_LEVEL = os.getenv("DELIVERA_WORKER_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("delivera.platform_worker")


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_json(value: Any, default: Any) -> Any:
    if not value:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def first_present(*values: Any) -> Any:
    for value in values:
        if value is not None and str(value).strip() != "":
            return value
    return ""


def get_path(data: Any, path: str) -> Any:
    current = data
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def normalize_money(value: Any) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def normalize_quantity(value: Any) -> int:
    try:
        parsed = int(float(value or 1))
        return parsed if parsed > 0 else 1
    except (TypeError, ValueError):
        return 1


def normalize_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    normalized = []
    for index, item in enumerate(items, start=1):
        item = item if isinstance(item, dict) else {}
        name = first_present(
            item.get("name"),
            item.get("productName"),
            item.get("title"),
            item.get("product"),
            f"Urun {index}",
        )
        normalized.append(
            {
                "id": str(first_present(item.get("id"), f"item-{index}")),
                "name": str(name),
                "quantity": normalize_quantity(first_present(item.get("quantity"), item.get("qty"), item.get("count"), 1)),
                "price": normalize_money(first_present(item.get("price"), item.get("unitPrice"), item.get("totalPrice"), 0)),
            }
        )
    return normalized


def parse_expiry(value: Any) -> dt.datetime | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value, tz=dt.timezone.utc)
    text = str(value).strip()
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = dt.datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def canonical_platform(value: str) -> str:
    return SUPPORTED_PLATFORMS.get(str(value or "").strip().lower(), str(value or "").strip())


def row_get(row: sqlite3.Row, key: str, default: Any = "") -> Any:
    return row[key] if key in row.keys() and row[key] is not None else default


@dataclasses.dataclass
class PlatformAccount:
    id: str
    restaurant_id: str
    restaurant_name: str
    restaurant_api_key: str
    restaurant_webhook_secret: str
    restaurant_zone: str
    restaurant_latitude: float
    restaurant_longitude: float
    platform: str
    external_store_id: str
    external_merchant_id: str
    client_id: str
    client_secret: str
    api_key: str
    api_secret: str
    access_token: str
    refresh_token: str
    token_expires_at: str
    settings: dict[str, Any]


class DeliveraDatabase:
    def __init__(self, db_file: str) -> None:
        self.db_file = db_file

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_file, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def table_columns(self, conn: sqlite3.Connection, table: str) -> set[str]:
        return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}

    def active_accounts(self) -> list[PlatformAccount]:
        with self.connect() as conn:
            tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "platform_accounts" in tables:
                return self._active_platform_accounts(conn)
            return self._active_flat_restaurant_accounts(conn)

    def _active_platform_accounts(self, conn: sqlite3.Connection) -> list[PlatformAccount]:
        rows = conn.execute(
            """
            SELECT
              pa.*,
              r.name AS restaurant_name,
              r.api_key AS restaurant_api_key,
              r.webhook_secret AS restaurant_webhook_secret,
              r.zone AS restaurant_zone,
              r.x AS restaurant_latitude,
              r.y AS restaurant_longitude
            FROM platform_accounts pa
            JOIN restaurants r ON r.id = pa.restaurant_id
            WHERE COALESCE(pa.is_active, pa.active, 1) = 1
            ORDER BY datetime(pa.updated_at) DESC
            """
        ).fetchall()
        accounts = []
        for row in rows:
            platform = canonical_platform(row["platform"])
            if platform not in PLATFORM_ENV_PREFIX:
                continue
            settings = parse_json(row["settings_json"], {})
            accounts.append(
                PlatformAccount(
                    id=row["id"],
                    restaurant_id=row["restaurant_id"],
                    restaurant_name=row["restaurant_name"],
                    restaurant_api_key=row["restaurant_api_key"],
                    restaurant_webhook_secret=row["restaurant_webhook_secret"],
                    restaurant_zone=row["restaurant_zone"],
                    restaurant_latitude=float(row["restaurant_latitude"]),
                    restaurant_longitude=float(row["restaurant_longitude"]),
                    platform=platform,
                    external_store_id=row["external_store_id"] or "",
                    external_merchant_id=row["external_merchant_id"] or "",
                    client_id=first_present(row_get(row, "api_username"), row_get(row, "api_key")),
                    client_secret=first_present(row_get(row, "api_password"), row_get(row, "api_secret")),
                    api_key=row_get(row, "api_key"),
                    api_secret=row_get(row, "api_secret"),
                    access_token=first_present(row_get(row, "access_token"), row_get(row, "token")),
                    refresh_token=row_get(row, "refresh_token"),
                    token_expires_at=row_get(row, "token_expires_at"),
                    settings=settings if isinstance(settings, dict) else {},
                )
            )
        return accounts

    def _active_flat_restaurant_accounts(self, conn: sqlite3.Connection) -> list[PlatformAccount]:
        columns = self.table_columns(conn, "restaurants")
        needed = {"platform_type", "client_id", "client_secret"}
        if not needed.issubset(columns):
            logger.warning("No platform_accounts table or flat restaurant credential columns found.")
            return []
        if {"active", "is_active"}.issubset(columns):
            active_filter = "WHERE COALESCE(active, is_active, 1) = 1"
        elif "active" in columns:
            active_filter = "WHERE COALESCE(active, 1) = 1"
        elif "is_active" in columns:
            active_filter = "WHERE COALESCE(is_active, 1) = 1"
        else:
            active_filter = ""
        rows = conn.execute(f"SELECT * FROM restaurants {active_filter}").fetchall()
        accounts = []
        for row in rows:
            platform = canonical_platform(row["platform_type"])
            if platform not in PLATFORM_ENV_PREFIX:
                continue
            settings = parse_json(row_get(row, "settings_json"), {})
            accounts.append(
                PlatformAccount(
                    id=f"restaurant:{row['id']}:{platform}",
                    restaurant_id=row["id"],
                    restaurant_name=row_get(row, "name", row["id"]),
                    restaurant_api_key=row_get(row, "api_key", os.getenv("DELIVERA_INTEGRATION_API_KEY", "")),
                    restaurant_webhook_secret=row_get(row, "webhook_secret", os.getenv("DELIVERA_WEBHOOK_SECRET", "")),
                    restaurant_zone=row_get(row, "zone", os.getenv("DELIVERA_DEFAULT_ZONE", "Merkez")),
                    restaurant_latitude=float(row_get(row, "x", os.getenv("DELIVERA_DEFAULT_LATITUDE", "0"))),
                    restaurant_longitude=float(row_get(row, "y", os.getenv("DELIVERA_DEFAULT_LONGITUDE", "0"))),
                    platform=platform,
                    external_store_id=first_present(row_get(row, "restaurant_id"), row["id"]),
                    external_merchant_id="",
                    client_id=row["client_id"],
                    client_secret=row["client_secret"],
                    api_key=row["client_id"],
                    api_secret=row["client_secret"],
                    access_token=row_get(row, "access_token"),
                    refresh_token=row_get(row, "refresh_token"),
                    token_expires_at=row_get(row, "token_expires_at"),
                    settings=settings if isinstance(settings, dict) else {},
                )
            )
        return accounts

    def update_token(self, account: PlatformAccount, token: dict[str, Any]) -> None:
        expires_in = int(token.get("expires_in") or 3300)
        expires_at = utc_now() + dt.timedelta(seconds=max(expires_in - 60, 60))
        access_token = str(token.get("access_token") or "")
        refresh_token = str(token.get("refresh_token") or account.refresh_token or "")
        expires_iso = expires_at.isoformat(timespec="seconds").replace("+00:00", "Z")

        with self.connect() as conn:
            tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "platform_accounts" in tables and not account.id.startswith("restaurant:"):
                conn.execute(
                    """
                    UPDATE platform_accounts
                    SET access_token = ?, token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (access_token, access_token, refresh_token, expires_iso, iso_now(), account.id),
                )
            else:
                columns = self.table_columns(conn, "restaurants")
                if {"access_token", "refresh_token", "token_expires_at"}.issubset(columns):
                    conn.execute(
                        """
                        UPDATE restaurants
                        SET access_token = ?, refresh_token = ?, token_expires_at = ?
                        WHERE id = ?
                        """,
                        (access_token, refresh_token, expires_iso, account.restaurant_id),
                    )
            conn.commit()

        account.access_token = access_token
        account.refresh_token = refresh_token
        account.token_expires_at = expires_iso

    def order_seen(self, account: PlatformAccount, platform_order_id: str) -> bool:
        if not platform_order_id:
            return True
        with self.connect() as conn:
            tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "platform_orders" in tables:
                row = conn.execute(
                    """
                    SELECT 1 FROM platform_orders
                    WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
                    LIMIT 1
                    """,
                    (account.platform, platform_order_id, account.restaurant_id),
                ).fetchone()
                if row:
                    return True
            if "packages" in tables:
                row = conn.execute(
                    """
                    SELECT 1 FROM packages
                    WHERE restaurant_id = ?
                      AND (external_order_id = ? OR external_order_no = ?)
                      AND source IN ('platform_api', 'platform_webhook')
                    LIMIT 1
                    """,
                    (account.restaurant_id, platform_order_id, platform_order_id),
                ).fetchone()
                return bool(row)
        return False

    def mark_last_sync(self, account: PlatformAccount) -> None:
        if account.id.startswith("restaurant:"):
            return
        with self.connect() as conn:
            conn.execute(
                "UPDATE platform_accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?",
                (iso_now(), iso_now(), account.id),
            )
            conn.commit()


class ProcessedOrderCache:
    def __init__(self, cache_file: str) -> None:
        self.cache_file = cache_file
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_orders (
                    platform TEXT NOT NULL,
                    restaurant_id TEXT NOT NULL,
                    order_id TEXT NOT NULL,
                    processed_at TEXT NOT NULL,
                    PRIMARY KEY (platform, restaurant_id, order_id)
                )
                """
            )
            conn.commit()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.cache_file, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def has(self, platform: str, restaurant_id: str, order_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT 1 FROM processed_orders
                WHERE platform = ? AND restaurant_id = ? AND order_id = ?
                LIMIT 1
                """,
                (platform, restaurant_id, order_id),
            ).fetchone()
            return bool(row)

    def mark(self, platform: str, restaurant_id: str, order_id: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO processed_orders (platform, restaurant_id, order_id, processed_at)
                VALUES (?, ?, ?, ?)
                """,
                (platform, restaurant_id, order_id, iso_now()),
            )
            conn.commit()


class OAuth2TokenManager:
    def __init__(self, database: DeliveraDatabase) -> None:
        self.database = database
        self.session = requests.Session()

    def valid_token(self, account: PlatformAccount) -> str:
        expires_at = parse_expiry(account.token_expires_at)
        if account.access_token and expires_at and expires_at > utc_now() + dt.timedelta(seconds=30):
            return account.access_token

        token_url = account.settings.get("tokenUrl") or account.settings.get("token_url") or os.getenv(
            f"{PLATFORM_ENV_PREFIX[account.platform]}_TOKEN_URL", ""
        )
        if not token_url:
            return account.access_token

        payload = {
            "client_id": account.client_id,
            "client_secret": account.client_secret,
        }
        if account.refresh_token:
            payload.update({"grant_type": "refresh_token", "refresh_token": account.refresh_token})
        else:
            payload.update({"grant_type": "client_credentials"})

        response = self.session.post(token_url, data=payload, timeout=15)
        if response.status_code == 401 and account.refresh_token:
            payload.pop("refresh_token", None)
            payload["grant_type"] = "client_credentials"
            response = self.session.post(token_url, data=payload, timeout=15)
        response.raise_for_status()
        token = response.json()
        if not token.get("access_token"):
            raise RuntimeError(f"{account.platform} token response did not include access_token")
        self.database.update_token(account, token)
        logger.info("Refreshed %s token for restaurant=%s account=%s", account.platform, account.restaurant_id, account.id)
        return account.access_token


class PlatformAdapter:
    def __init__(self, account, token_manager):
        self.account = account
        self.token_manager = token_manager
        self.session = requests.Session()

    def orders_url(self) -> str:
        if self.account.platform == "Trendyol Go":
            base = os.getenv("TRENDYOL_BASE_URL", "https://api.trendyol.com/sapigw").rstrip("/")
            seller_id = os.getenv("TRENDYOL_SELLER_ID", "").strip()

            if not seller_id:
                raise RuntimeError("TRENDYOL_SELLER_ID .env içinde yok")

            logger.info("🔥 Using Trendyol Seller ID: %s", seller_id)

            url = f"{base}/suppliers/{seller_id}/orders"
            logger.info("🔥 Trendyol orders URL: %s", url)

            return url

        raise RuntimeError(f"{self.account.platform} orders endpoint is not configured")

    def headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

        # 🔥 AUTH FIX
        api_key = os.getenv("TRENDYOL_API_KEY")
        api_secret = os.getenv("TRENDYOL_API_SECRET")
        logger.info("API KEY CHECK: %s", api_key)
        logger.info("API SECRET CHECK: %s", api_secret)

        if api_key and api_secret:
            raw = f"{api_key}:{api_secret}".encode("utf-8")
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
            headers["User-Agent"] = "RESTOMAP/1.0"

        return headers

        raise RuntimeError(f"{self.account.platform} orders endpoint is not configured")

    def request_params(self) -> dict[str, str]:
        settings = self.account.settings
        params = parse_json(settings.get("ordersParams") or settings.get("orders_params"), {})
        if not isinstance(params, dict):
            params = {}
        if self.account.platform == "Trendyol Go":
            params.setdefault("status", "Created")
        return {str(key): str(value) for key, value in params.items() if value not in (None, "")}

    def fetch_new_orders(self) -> list[dict[str, Any]]:
        url = self.orders_url()
        response = self.session.get(url, headers=self.headers(), params=self.request_params(), timeout=20)
        response.raise_for_status()
        data = response.json()
        orders = self.extract_orders(data)
        return [order for order in orders if self.is_new_order(order)]

    def extract_orders(self, data: Any) -> list[dict[str, Any]]:
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if not isinstance(data, dict):
            return []
        for key in ("orders", "foodOrders", "items", "content", "data", "results"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        return []

    def is_new_order(self, raw: dict[str, Any]) -> bool:
        status = str(first_present(raw.get("status"), raw.get("orderStatus"), raw.get("state"), raw.get("packageStatus"))).lower()
        if not status:
            return True
        new_statuses = parse_json(self.account.settings.get("newOrderStatuses"), None)
        if isinstance(new_statuses, list) and new_statuses:
            return status in {str(item).lower() for item in new_statuses}
        return any(marker in status for marker in ("created", "new", "pending", "waiting", "preparing", "accepted"))

    def normalize_order(self, raw: dict[str, Any]) -> dict[str, Any]:
        order = raw.get("order") if isinstance(raw.get("order"), dict) else raw
        platform_order_id = str(
            first_present(
                raw.get("orderId"),
                raw.get("order_id"),
                raw.get("externalOrderId"),
                raw.get("external_order_id"),
                order.get("orderNumber"),
                order.get("order_number"),
                order.get("orderNo"),
                order.get("id"),
            )
        )
        customer = order.get("customer") if isinstance(order.get("customer"), dict) else {}
        payment = order.get("payment") if isinstance(order.get("payment"), dict) else {}
        delivery_address = order.get("deliveryAddress") if isinstance(order.get("deliveryAddress"), dict) else {}

        address = first_present(
            raw.get("address"),
            raw.get("deliveryAddress"),
            order.get("address"),
            order.get("deliveryAddress") if isinstance(order.get("deliveryAddress"), str) else "",
            delivery_address.get("address1"),
            delivery_address.get("address"),
        )
        customer_name = first_present(
            raw.get("customerName"),
            raw.get("customer_name"),
            order.get("customerName"),
            customer.get("fullName"),
            customer.get("name"),
            "Platform Musteri",
        )
        phone = first_present(raw.get("phone"), order.get("phone"), customer.get("phoneNumber"), customer.get("phone"), "Gizli Numara")
        items = normalize_items(first_present(raw.get("items"), raw.get("products"), order.get("items"), order.get("products"), order.get("lines"), []))
        total_price = normalize_money(first_present(raw.get("totalPrice"), raw.get("total_price"), order.get("totalPrice"), order.get("totalAmount"), order.get("amount"), payment.get("totalPrice"), payment.get("amount")))
        payment_method = str(first_present(raw.get("paymentMethod"), raw.get("payment_method"), order.get("paymentMethod"), payment.get("method"), "Online Odeme"))

        return {
            "restaurantId": self.account.restaurant_id,
            "orderId": platform_order_id,
            "platform": self.account.platform,
            "customer": {
                "name": str(customer_name),
                "phone": str(phone),
            },
            "address": str(address),
            "price": total_price,
            "totalPrice": total_price,
            "items": items,
            "paymentMethod": payment_method,
            "zone": self.account.restaurant_zone,
            "note": str(first_present(raw.get("customerNote"), raw.get("customer_note"), raw.get("note"), order.get("note"), "")),
            "customerNote": str(first_present(raw.get("customerNote"), raw.get("customer_note"), raw.get("note"), order.get("note"), "")),
            "customerLatitude": first_present(raw.get("customerLatitude"), raw.get("customer_lat"), get_path(order, "deliveryLocation.lat"), delivery_address.get("lat"), delivery_address.get("latitude")),
            "customerLongitude": first_present(raw.get("customerLongitude"), raw.get("customer_lng"), get_path(order, "deliveryLocation.lng"), delivery_address.get("lng"), delivery_address.get("longitude")),
            "customerAddress": str(address),
            "latitude": self.account.restaurant_latitude,
            "longitude": self.account.restaurant_longitude,
            "rawPayload": raw,
        }


class DeliveraApiClient:
    def __init__(self, base_url: str, integration_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.integration_key = integration_key
        self.session = requests.Session()

    def create_order(self, account: PlatformAccount, payload: dict[str, Any]) -> requests.Response:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self.session.post(
            f"{self.base_url}/api/integrations/orders",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "x-integration-key": self.integration_key,
            },
            timeout=20,
        )


class PlatformWorker:
    def __init__(self) -> None:
        self.database = DeliveraDatabase(os.getenv("DATABASE_PATH", os.getenv("DB_PATH", os.getenv("DELIVERA_DB_FILE", DEFAULT_DB_FILE))))
        self.cache = ProcessedOrderCache(os.getenv("DELIVERA_WORKER_CACHE_FILE", DEFAULT_CACHE_FILE))
        self.api = DeliveraApiClient(
            os.getenv("DELIVERA_API_BASE_URL", "https://paketdelivera.onrender.com"),
            os.getenv("DELIVERA_INTEGRATION_KEY", ""),
        )
        self.token_manager = OAuth2TokenManager(self.database)
        self.poll_interval = float(os.getenv("DELIVERA_WORKER_POLL_SECONDS", "30"))
        self.account_delay = float(os.getenv("DELIVERA_WORKER_ACCOUNT_DELAY_SECONDS", "1.2"))
        self.processed: set[tuple[str, str, str]] = set()
        self.running = True
        if not self.api.integration_key:
            logger.warning("DELIVERA_INTEGRATION_KEY is empty; backend will reject worker requests.")

    def stop(self, *_args: Any) -> None:
        self.running = False

    def run_forever(self) -> None:
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)
        logger.info("RESTOMAP platform worker started poll_interval=%ss", self.poll_interval)
        while self.running:
            started = time.monotonic()
            try:
                self.poll_once()
            except Exception:
                logger.exception("Unexpected worker loop failure")
            elapsed = time.monotonic() - started
            sleep_for = max(self.poll_interval - elapsed, 1)
            time.sleep(sleep_for)

    def poll_once(self) -> None:
        accounts = self.database.active_accounts()
        logger.info("Polling %s active platform account(s)", len(accounts))
        for account in accounts:
            try:
                self.poll_account(account)
            except Exception:
                logger.exception("Polling failed restaurant=%s platform=%s account=%s", account.restaurant_id, account.platform, account.id)
            finally:
                time.sleep(self.account_delay)

    def poll_account(self, account: PlatformAccount) -> None:
        adapter = PlatformAdapter(account, self.token_manager)
        orders = adapter.fetch_new_orders()
        created_count = 0
        for raw_order in orders:
            payload = adapter.normalize_order(raw_order)
            order_id = payload["orderId"]
            dedupe_key = (account.platform, account.restaurant_id, order_id)
            if dedupe_key in self.processed or self.cache.has(account.platform, account.restaurant_id, order_id) or self.database.order_seen(account, order_id):
                self.processed.add(dedupe_key)
                continue

            try:
                response = self.api.create_order(account, payload)
            except requests.RequestException as error:
                logger.error(
                    "Backend unavailable; will retry later platform=%s restaurant=%s order=%s error=%s",
                    account.platform,
                    account.restaurant_id,
                    order_id,
                    error,
                )
                continue

            if response.status_code in (200, 201):
                self.processed.add(dedupe_key)
                self.cache.mark(account.platform, account.restaurant_id, order_id)
                created_count += 1 if response.status_code == 201 else 0
                logger.info("Fed order platform=%s restaurant=%s order=%s status=%s", account.platform, account.restaurant_id, order_id, response.status_code)
            elif response.status_code == 429:
                retry_after = response.headers.get("Retry-After", "5")
                logger.warning("RESTOMAP API rate limited; sleeping %ss", retry_after)
                try:
                    time.sleep(float(retry_after))
                except ValueError:
                    time.sleep(5)
            else:
                logger.error(
                    "RESTOMAP API rejected order platform=%s restaurant=%s order=%s status=%s body=%s",
                    account.platform,
                    account.restaurant_id,
                    order_id,
                    response.status_code,
                    response.text[:500],
                )
        self.database.mark_last_sync(account)
        logger.info("Account poll done platform=%s restaurant=%s fetched=%s created=%s", account.platform, account.restaurant_id, len(orders), created_count)


def main() -> int:
    worker = PlatformWorker()
    worker.run_forever()
    logger.info("RESTOMAP platform worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
