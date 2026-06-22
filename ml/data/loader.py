"""
Database loader for ML training data.
Connects to PostgreSQL and loads draw_odds history.
"""

import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def get_connection():
    """Get database connection from DATABASE_URL."""
    import psycopg2

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable is required")

    return psycopg2.connect(database_url)


def load_point_history(
    state_code: str,
    species_slug: str,
    unit_code: str,
) -> list[dict]:
    """Load historical min_points_drawn for a state+species+unit combination.

    Returns:
        list of {year, min_points, effective_points, point_system_type}.

    The forecaster should consume `effective_points` when projecting trends
    across state lines — raw `min_points` is incomparable between
    bonus / bonus_squared / pure_preference systems. Within a single
    (state, species, unit) series the two are equivalent for pure_preference
    states and proportional for bonus systems, so backward compatibility is
    preserved for callers that still read `min_points`.
    """
    try:
        conn = get_connection()
        cur = conn.cursor()

        cur.execute(
            """
            SELECT
                do.year,
                do.min_points_drawn,
                do.effective_points,
                do.point_system_type
            FROM draw_odds do
            JOIN states s ON do.state_id = s.id
            JOIN species sp ON do.species_id = sp.id
            LEFT JOIN hunt_units hu ON do.hunt_unit_id = hu.id
            WHERE s.code = %s
              AND sp.slug = %s
              AND (hu.unit_code = %s OR %s IS NULL)
              AND do.min_points_drawn IS NOT NULL
            ORDER BY do.year ASC
            """,
            (state_code, species_slug, unit_code, unit_code),
        )

        rows = cur.fetchall()
        cur.close()
        conn.close()

        return [
            {
                "year": row[0],
                "min_points": row[1],
                # Fallback to raw min_points when effective_points hasn't been
                # backfilled yet (pre-migration data).
                "effective_points": row[2] if row[2] is not None else row[1],
                "point_system_type": row[3] or "pure_preference",
            }
            for row in rows
        ]
    except Exception as e:
        logger.error(f"Failed to load point history: {e}")
        return []


def load_draw_history(
    state_code: str,
    species_slug: str,
    unit_code: str,
) -> list[dict]:
    """Load historical draw odds data for training."""
    try:
        conn = get_connection()
        cur = conn.cursor()

        cur.execute(
            """
            SELECT
                do.year,
                do.total_applicants,
                do.total_tags,
                do.min_points_drawn,
                do.max_points_drawn,
                do.draw_rate,
                do.resident_type,
                do.weapon_type
            FROM draw_odds do
            JOIN states s ON do.state_id = s.id
            JOIN species sp ON do.species_id = sp.id
            LEFT JOIN hunt_units hu ON do.hunt_unit_id = hu.id
            WHERE s.code = %s
              AND sp.slug = %s
              AND (hu.unit_code = %s OR %s IS NULL)
            ORDER BY do.year ASC
            """,
            (state_code, species_slug, unit_code, unit_code),
        )

        rows = cur.fetchall()
        cur.close()
        conn.close()

        results = []
        prev_min_points = None

        for row in rows:
            min_points = row[3] or 0

            # Calculate point creep slope
            point_creep_slope = 0.0
            if prev_min_points is not None:
                point_creep_slope = min_points - prev_min_points
            prev_min_points = min_points

            results.append({
                "year": row[0],
                "total_applicants": row[1] or 100,
                "total_tags": row[2] or 10,
                "min_points_drawn": min_points,
                "max_points_drawn": row[4] or 0,
                "draw_rate": row[5] or 0.1,
                "point_type": "preference",  # default
                "point_creep_slope": point_creep_slope,
                "drawn": True,  # historical records represent drawn data
                "points_at_draw": min_points,
            })

        return results
    except Exception as e:
        logger.error(f"Failed to load draw history: {e}")
        return []


def load_training_data():
    """Load all draw odds data for bulk training.

    Includes the normalized point fields (effective_points, point_system_type)
    so the model can either project all data onto a common axis or partition
    training by point_system_type.
    """
    try:
        import pandas as pd

        conn = get_connection()
        query = """
            SELECT
                s.code as state_code,
                sp.slug as species_slug,
                hu.unit_code,
                do.year,
                do.total_applicants,
                do.total_tags,
                do.min_points_drawn,
                do.effective_points,
                do.point_system_type,
                do.draw_rate,
                do.resident_type,
                do.weapon_type
            FROM draw_odds do
            JOIN states s ON do.state_id = s.id
            JOIN species sp ON do.species_id = sp.id
            LEFT JOIN hunt_units hu ON do.hunt_unit_id = hu.id
            WHERE do.min_points_drawn IS NOT NULL
            ORDER BY s.code, sp.slug, hu.unit_code, do.year
        """

        df = pd.read_sql(query, conn)
        conn.close()

        # Filter for combinations with >= 3 years of data
        group_counts = df.groupby(
            ["state_code", "species_slug", "unit_code"]
        ).size()
        valid_groups = group_counts[group_counts >= 3].index

        df_filtered = df.set_index(
            ["state_code", "species_slug", "unit_code"]
        ).loc[valid_groups].reset_index()

        logger.info(
            f"Loaded {len(df_filtered)} records from "
            f"{len(valid_groups)} valid groups"
        )

        return df_filtered
    except Exception as e:
        logger.error(f"Failed to load training data: {e}")
        return None
