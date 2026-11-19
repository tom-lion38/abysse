import unittest

from abysse.debit import CompteurDebit


class TestDebit(unittest.TestCase):
    def test_debit_premier_echantillon_none(self):
        d = CompteurDebit()
        self.assertIsNone(d.maj("e1", 123456, 10.0))

    def test_debit_calcul(self):
        d = CompteurDebit()
        self.assertIsNone(d.maj("e1", 0, 0.0))
        self.assertEqual(d.maj("e1", 1_250_000, 1.0), 10_000_000.0)

    def test_debit_chaine(self):
        d = CompteurDebit()
        self.assertIsNone(d.maj("e1", "0", 0.0))
        self.assertEqual(d.maj("e1", "1250000", 1.0), 10_000_000.0)

    def test_debit_compteur_recule(self):
        d = CompteurDebit()
        d.maj("e1", 0, 0.0)
        d.maj("e1", 1_000_000, 1.0)
        self.assertIsNone(d.maj("e1", 10, 2.0))
        # l'échantillon suivant repart de la nouvelle base : débit normal
        self.assertEqual(d.maj("e1", 10 + 1_250_000, 3.0), 10_000_000.0)

    def test_debit_intervalle_nul(self):
        d = CompteurDebit()
        d.maj("e1", 0, 5.0)
        self.assertIsNone(d.maj("e1", 1_000, 5.0))
        # le temps qui recule non plus ne donne pas de débit
        self.assertIsNone(d.maj("e1", 2_000, 4.0))

    def test_cles_independantes(self):
        d = CompteurDebit()
        d.maj("a", 0, 0.0)
        self.assertIsNone(d.maj("b", 500, 1.0))
        self.assertEqual(d.maj("a", 125, 1.0), 1000.0)

    def test_valeur_invalide(self):
        d = CompteurDebit()
        d.maj("e1", 0, 0.0)
        self.assertIsNone(d.maj("e1", "n/a", 1.0))
        self.assertIsNone(d.maj("e1", None, 1.5))  # type: ignore[arg-type]
        self.assertIsNone(d.maj("e1", -5, 1.7))
        # une valeur invalide ne casse pas la référence précédente
        self.assertEqual(d.maj("e1", 250_000, 2.0), 1_000_000.0)

    def test_pic_absurde(self):
        d = CompteurDebit()
        d.maj("e1", 0, 0.0)
        # 10 To en 1 s : impossible sur ce réseau
        self.assertIsNone(d.maj("e1", 10_000_000_000_000, 1.0))
        self.assertEqual(d.maj("e1", 10_000_000_000_000 + 125, 2.0), 1000.0)

    def test_retour_float(self):
        d = CompteurDebit()
        d.maj("e1", 0, 0.0)
        v = d.maj("e1", 1, 4.0)
        self.assertIsInstance(v, float)
        self.assertEqual(v, 2.0)


if __name__ == "__main__":
    unittest.main()


class TestDebitSuivi(unittest.TestCase):
    def test_horloge_qui_recule_rebase(self):
        c = CompteurDebit()
        c.maj("e1", 1000, 1001.0)
        self.assertIsNone(c.maj("e1", 2000, 501.0))
        self.assertEqual(c.maj("e1", 2000 + 125_000, 502.0), 1_000_000.0)

    def test_oublier(self):
        c = CompteurDebit()
        c.maj("app-1", 10, 0.0)
        c.oublier("app-1")
        self.assertIsNone(c.maj("app-1", 20, 1.0))
