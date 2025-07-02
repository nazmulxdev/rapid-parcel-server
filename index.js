import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.pAYMENT_GATEWAY_kEY);

app.use(cors());
app.use(express.json());

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // starting crud operation
    const dataBase = client.db("rapidParcelDb");
    const parcelCollection = dataBase.collection("parcels");
    const paymentsCollection = dataBase.collection("payments");
    const trackingCollection = dataBase.collection("tracking");
    const usersCollection = dataBase.collection("users");

    // users collection

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: "user already exist", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // parcels api get
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;

        const query = email ? { senderEmail: email } : {};
        const options = {
          sort: { creation_date: -1 }, // latest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("🚨 Failed to fetch parcels:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // get method for specific parcel by id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.status(200).send(parcel);
      } catch (error) {
        console.error("❌ Failed to fetch parcel by ID:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // record payment history and update parcel status

    app.post("/payments", async (req, res) => {
      try {
        const {
          parcelId,
          userEmail,
          amount,
          transactionId,
          paymentIntentId,
          paymentMethod,
          cardBrand,
          cardLast4,
        } = req.body;

        if (
          !parcelId ||
          !transactionId ||
          !userEmail ||
          !amount ||
          !paymentMethod
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        // 🔍 1. Check if parcel already paid
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        if (parcel.payment_status === "paid") {
          return res.status(400).send({ message: "Parcel is already paid" });
        }

        // ✅ 2. Update parcel status
        await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
              transaction_id: transactionId,
              payment_method: paymentMethod,
            },
          },
        );

        // 🧾 3. Save payment record
        const paymentDoc = {
          parcelId,
          userEmail,
          amount,
          transactionId,
          paymentIntentId,
          paymentMethod,
          cardBrand,
          cardLast4,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const result = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          success: true,
          message: "Payment recorded and parcel marked as paid",
          paymentId: result.insertedId,
        });
      } catch (error) {
        console.error("❌ Payment processing failed:", error);
        res.status(500).send({ message: "Something went wrong" });
      }
    });

    // adding tracking payment of the parcel
    // app.post("/tracking", async (req, res) => {
    //   try {
    //     const {
    //       parcelId,
    //       tracking_id,
    //       status,
    //       location,
    //       updated_by,
    //     } = req.body;

    //     if (!parcelId || !tracking_id || !status || !location || !updated_by) {
    //       return res.status(400).send({ message: "Missing required fields" });
    //     }

    //     const update = {
    //       parcelId,
    //       tracking_id,
    //       status,
    //       location,
    //       updated_by,
    //       updated_at: new Date(),
    //     };

    //     const result = await trackingCollection.insertOne(update);

    //     res.send({
    //       success: true,
    //       message: "Tracking update saved",
    //       insertedId: result.insertedId,
    //     });
    //   } catch (err) {
    //     console.error("❌ Failed to add tracking:", err);
    //     res.status(500).send({ message: "Internal Server Error" });
    //   }
    // });

    // GET: Get all tracking updates by tracking ID
    // app.get("/tracking/:tracking_id", async (req, res) => {
    //   try {
    //     const { tracking_id } = req.params;

    //     const updates = await trackingCollection
    //       .find({ tracking_id })
    //       .sort({ updated_at: 1 }) // oldest to newest
    //       .toArray();

    //     if (updates.length === 0) {
    //       return res.status(404).send({ message: "No tracking updates found" });
    //     }

    //     res.send(updates);
    //   } catch (err) {
    //     console.error("❌ Failed to get tracking info:", err);
    //     res.status(500).send({ message: "Internal Server Error" });
    //   }
    // });

    // Get all tracking updates by parcelId
    // app.get("/tracking/:parcelId", async (req, res) => {
    //   try {
    //     const parcelId = req.params.parcelId;
    //     const trackingUpdates = await trackingCollection
    //       .find({ parcelId })
    //       .sort({ updated_at: 1 })
    //       .toArray();

    //     res.send(trackingUpdates);
    //   } catch (error) {
    //     console.error("❌ Tracking fetch error:", error);
    //     res.status(500).send({ message: "Failed to get tracking updates" });
    //   }
    // });
    // get payment history by email

    app.get("/myPayments", async (req, res) => {
      try {
        const email = req.query.email;

        const userPayments = await paymentsCollection
          .find({ userEmail: email })
          .sort({ paid_at: -1 })
          .toArray();

        res.send(userPayments);
      } catch (error) {
        console.error("❌ Fetch user payments failed:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // stripe payment system
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body;

        if (!amount) {
          return res.status(400).send({ message: "Amount is required" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount * 100, // convert to cents if using USD
          currency: "usd", // or "bdt", "eur", etc.
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("🔥 Stripe error:", error);
        res.status(500).send({ message: "Stripe payment creation failed" });
      }
    });

    // post api for stored parcel details
    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;
        const result = await parcelCollection.insertOne(parcelData);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel " });
      }
    });

    // delete parcel from api
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Delete failed" });
      }
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Rapid Parcel server is running");
});
app.listen(port, () => {
  console.log("This server is running on port", port);
});
