"""Calculs exacts : euros en centimes, volumes en millilitres."""
from decimal import Decimal, InvalidOperation


def decimal_units(value, factor, minimum, maximum, label):
    try:
        number = Decimal(str(value).replace(',', '.')) * factor
        if not number.is_finite() or number != number.to_integral_value():
            raise ValueError()
        result = int(number)
        if not minimum <= result <= maximum:
            raise ValueError()
        return result
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f'{label} invalide ou précision excessive.') from None


def allocate(cost_cents, volumes):
    """Méthode des plus forts restes, égalités départagées par identifiant."""
    volumes = {key: value for key, value in volumes.items() if value > 0}
    total = sum(volumes.values())
    if not total:
        return {}
    shares = {key: cost_cents * volume // total for key, volume in volumes.items()}
    remaining = cost_cents - sum(shares.values())
    ranked = sorted(volumes, key=lambda key: (-(cost_cents * volumes[key] % total), key))
    for key in ranked[:remaining]:
        shares[key] += 1
    return shares
