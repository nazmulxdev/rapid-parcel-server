import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import Stripe from "stripe";

// this is required import
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.pAYMENT_GATEWAY_kEY);

// add origin url and set app into cookie parser
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// token verifier

const verifyToken = (req, res, next) => {
  const token = req?.cookies?.token;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.JWT_SECRET, (error, decoded) => {
    if (error) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

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
    const ridersCollection = dataBase.collection("riders");

    // jwt token related api

    // mounting token in the cookie
    app.post("/validation", async (req, res) => {
      const { email } = req.body;
      const user = { email };
      const token = jwt.sign(user, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });
      // send to cookie
      res.cookie("token", token, {
        httpOnly: true,
        secure: false,
      });
      // send response
      res.send({ success: true });
    });

    // unmounting cookies after logout user
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
      });
      res.status(200).send({ message: "Logged out, cookie cleared" });
    });
    // users collection

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      const currentTime = new Date().toISOString();
      if (userExists) {
        // update last login info
        const updateLastLog = await usersCollection.updateOne(
          { email },
          {
            $set: {
              last_log_in: currentTime,
            },
          },
        );

        return res.status(200).send({
          message: "user already exist",
          inserted: false,
          result: updateLastLog,
        });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // all  riders

    app.post("/riders", async (req, res) => {
      try {
        const { email } = req.body;
        // checking rider email
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }
        // checking is the rider data is existed in the database
        const existingRider = await ridersCollection.findOne({ email });
        if (existingRider) {
          return res.status(409).send({
            message: "User has already applied as a rider",
            alreadyApplied: true,
          });
        }

        const riderInfo = req.body;
        const result = await ridersCollection.insertOne(riderInfo);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // parcels api get
    app.get("/parcels", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }
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

    app.get("/myPayments", verifyToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

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
